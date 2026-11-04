import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function readJSON(file: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
export async function atomicJSON(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await fs.rename(temp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fs.unlink(temp).catch(()=>{}); }
}
export class LedgerStore {
  constructor(readonly root: string) {}
  file(id: string) { return path.join(this.root, 'ledger-v2', digest(id)+'.json'); }
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.root, {recursive:true, mode:0o700});
    // Same lock path as v1. Never break a lock automatically, even when its PID is gone.
    const file = path.join(this.root, 'transition-'+digest(id)+'.lock');
    const h = await fs.open(file, 'wx', 0o600).catch(e=>{ if(e.code==='EEXIST')throw Error('Action busy or stale lock; inspect before retry');throw e; });
    try { await h.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString(),protocol:2})); await h.sync(); return await fn(); }
    finally { await h.close(); await fs.unlink(file); }
  }
  async reserveRun(runId: string, identity: unknown) {
    const dir=path.join(this.root,'ledger-v2-runs'); await fs.mkdir(dir,{recursive:true,mode:0o700});
    const file=path.join(dir,digest(runId)+'.json');
    let h;
    try { h=await fs.open(file,'wx',0o600); }
    catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      if(canonical(await readJSON(file))!==canonical(identity))throw Error('runId already reserved for another Action, identity or claim');
      return;
    }
    try { await h.writeFile(JSON.stringify(identity)); await h.sync(); } finally { await h.close(); }
  }
  async legacyExists(id: string) {
    const key=digest(id);
    for(const f of [path.join(this.root,'local-ownership',key+'.json'),path.join(this.root,'local-ownership',key+'.json.intent'),path.join(this.root,'pending',key+'.json')]) {
      if(await fs.stat(f).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return true;
    }
    const dir=path.join(this.root,'ownership');
    for(const file of await fs.readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
      const r=await readJSON(path.join(dir,file));
      if(r?.events?.some((e:any)=>e.id===id)||r?.latest?.id===id)return true;
    }
    return false;
  }
  async credential(actionId: string, transferId: string, eventId: string) {
    const file=path.join(this.root,'ledger-v2-grants',digest(actionId+':'+transferId+':'+eventId)+'.json');
    const token=crypto.randomBytes(32).toString('base64url');
    await atomicJSON(file,{credential:token});
    return {credentialHash:digest(token),credentialPath:file};
  }
}
