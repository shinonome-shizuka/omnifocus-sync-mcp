import { validateTransactionXml } from "./transaction-validation.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {StoreStorage, WebDavStorage} from "../storage/index.js";
import { WebDavClient } from "../webdav/client.js";
import {
  createId,
  decryptFile,
  DocumentKey,
  encryptFile,
  parseEncryptionMetadata,
} from "../crypto/index.js";
import { Database } from "./database.js";

const ENCRYPTED_METADATA = "encrypted";
const TXN_RE = /^(\d{14})=(.+)\.zip$/;

export interface TransactionFile {
  name: string;
  timestamp: string; // 14-digit GMT
  parents: string[];
  tail: string;
  isBaseline: boolean;
}

export interface StoreListing {
  transactions: TransactionFile[];
  clientFiles: string[];
  encrypted: boolean;
  signature?: string;
}

function parseTxnName(name: string): TransactionFile | null {
  const m = TXN_RE.exec(name);
  if (!m) return null;
  const ids = m[2].split("+");
  const tail = ids[ids.length - 1];
  const parents = ids.slice(0, -1);
  return {
    name,
    timestamp: m[1],
    parents,
    tail,
    isBaseline: m[1] === "00000000000000",
  };
}

export function utcStamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * A transport-independent OmniFocus transaction store. Handles listing, decryption,
 * state reconstruction, and writing new transactions.
 */
export class OmniFocusStore {
  private docKey: DocumentKey | null = null;

  readonly storage:StoreStorage;
  private loadedSignature:string|undefined;
  constructor(storage: StoreStorage | WebDavClient, ofocusUrl = '') {
    this.storage = storage && 'kind' in storage ? storage as StoreStorage : new WebDavStorage(storage as WebDavClient,ofocusUrl);
  }

  /** Load and unlock the encryption metadata with a passphrase, if present. */
  async unlock(passphrase: string): Promise<void> {
    const url = ENCRYPTED_METADATA;
    if (!(await this.storage.exists(url))) {
      throw new Error("Store is not encrypted (no `encrypted` metadata file)");
    }
    const meta = parseEncryptionMetadata(await this.storage.read(url));
    this.docKey = DocumentKey.fromMetadata(meta, passphrase);
  }

  get isEncrypted(): boolean {
    return this.docKey != null;
  }

  async list(): Promise<StoreListing> {
    const entries = await this.storage.list();
    const transactions: TransactionFile[] = [];
    const clientFiles: string[] = [];
    let encrypted = false;
    for (const e of entries) {
      if (e.isCollection) continue;
      if (e.name === ENCRYPTED_METADATA) {
        encrypted = true;
        continue;
      }
      if (e.name.endsWith(".client")) {
        clientFiles.push(e.name);
        continue;
      }
      const txn = parseTxnName(e.name);
      if (txn) transactions.push(txn);
    }
    // Chronological order; baseline (00000000000000) naturally sorts first.
    transactions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const signature=JSON.stringify(entries.filter(e=>e.name.endsWith('.zip')||e.name==='encrypted').map(e=>[e.name,'revision' in e?e.revision:null]).sort());
    return { transactions, clientFiles, encrypted, signature };
  }

  /** list() with retry — the first PROPFIND is the most exposed to a flaky server. */
  async listResilient(attempts = this.storage.kind === "local" ? 1 : 8): Promise<StoreListing> {
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      try {
        return await this.list();
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
      }
    }
    throw last;
  }

  /** Fetch a transaction file and return its decrypted contents.xml text. */
  async readContents(name: string): Promise<string> {
    let bytes = await this.storage.read(name);
    if (this.docKey) bytes = decryptFile(this.docKey, name, bytes);
    const files = unzipSync(new Uint8Array(bytes));
    const entry = files["contents.xml"];
    if (!entry) throw new Error(`No contents.xml in ${name}`);
    return strFromU8(entry);
  }

  /** readContents with per-file retry — one flaky GET must not kill a full replay. */
  private async readContentsResilient(name: string, attempts = this.storage.kind === "local" ? 1 : 5): Promise<string> {
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      try {
        return await this.readContents(name);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
      }
    }
    throw last;
  }

  /** Reconstruct a consistent snapshot in transaction-parent order. */
  async loadDatabase(): Promise<{ db: Database; listing: StoreListing; headTail: string | null }> {
    for(let attempt=0;attempt<3;attempt++){
      const listing=await this.listResilient();
      if(!listing.transactions.some(t=>t.isBaseline))throw Error('OmniFocus baseline missing');
      const db=new Database();
      const pending=[...listing.transactions], applied=new Set<string>();
      // Parent order, not wall-clock order: clock skew and merge branches are valid.
      while(pending.length){
        const index=pending.findIndex(t=>t.isBaseline||t.parents.every(p=>applied.has(p)));
        if(index<0)throw Error('Transaction history has missing parents or a cycle');
        const [txn]=pending.splice(index,1);
        db.applyTransaction(await this.readContentsResilient(txn.name));applied.add(txn.tail);
      }
      const after=await this.listResilient();
      if(after.signature!==listing.signature)continue;
      this.loadedSignature=listing.signature;
      return {db,listing,headTail:this.computeHeadTail(listing.transactions)};
    }
    throw Error('Database changed during read; retry');
  }

  /** The current head tail id = a tail that no other transaction lists as a parent. */
  computeHeadTail(transactions: TransactionFile[]): string | null {
    if (transactions.length === 0) return null;
    const parents = new Set<string>();
    for (const t of transactions) for (const p of t.parents) parents.add(p);
    const heads = transactions.filter((t) => !parents.has(t.tail));
    const pool = heads.length > 0 ? heads : transactions;
    // Prefer the newest by timestamp/name.
    pool.sort((a, b) => (a.name < b.name ? 1 : -1));
    return pool[0].tail;
  }

  /**
   * Write a new transaction containing the given contents.xml, descending from
   * `parents` (usually the current head tail). Returns the new file name + tail.
   */
  async writeTransaction(
    contentsXml: string,
    parents: string[],
  ): Promise<{ name: string; tail: string }> {
    validateTransactionXml(contentsXml);
    if(this.loadedSignature!==undefined && (await this.listResilient()).signature!==this.loadedSignature)throw Error('Database changed before commit; no transaction written. Refresh before retrying.');
    const tail = createId();
    const chain = [...parents, tail].join("+");
    const name = `${utcStamp()}=${chain}.zip`;
    const zip = zipSync({ "contents.xml": strToU8(contentsXml) }, { level: 6 });
    let payload: Uint8Array = Buffer.from(zip);
    if (this.docKey) payload = encryptFile(this.docKey, name, Buffer.from(payload));
    await this.storage.write(name, payload);
    return { name, tail };
  }

  async readAttachmentData(identifier:string):Promise<Uint8Array>{
    if(!/^data-[a-zA-Z0-9_-]+$/.test(identifier))throw Error('Invalid attachment data identifier');
    const name='data/'+identifier+'.zip';
    let bytes=await this.storage.read(name);
    if(this.docKey)bytes=Buffer.from(decryptFile(this.docKey,identifier+'.zip',bytes));
    return bytes;
  }

  /** Write (or refresh) a `.client` registration file. */
  async writeClientFile(clientId: string, plistXml: string): Promise<string> {
    const name = `${utcStamp()}=${clientId}.client`;
    let payload: Uint8Array = Buffer.from(plistXml, "utf8");
    if (this.docKey) payload = encryptFile(this.docKey, name, Buffer.from(plistXml, "utf8"));
    await this.storage.write(name, payload);
    return name;
  }

  async ensureExists(): Promise<void> {
    await this.storage.create();
  }
}
