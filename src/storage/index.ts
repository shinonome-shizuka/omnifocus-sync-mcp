import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {WebDavClient} from '../webdav/client.js';

export interface StorageEntry {name:string; isCollection:boolean; revision?:string}
/** Only byte storage differs between local files and WebDAV. */
export interface StoreStorage {
  readonly identity:string;
  readonly kind:'local'|'remote';
  list():Promise<StorageEntry[]>;
  read(name:string):Promise<Buffer>;
  write(name:string,bytes:Uint8Array):Promise<void>;
  exists(name:string):Promise<boolean>;
  create():Promise<void>;
}
export class WebDavStorage implements StoreStorage {
  readonly kind='remote' as const;
  readonly identity:string;
  constructor(private readonly client:WebDavClient, private readonly url:string){this.identity=url;}
  private child(name:string){return this.url.replace(/\/+$/,'')+'/'+name.split('/').map(encodeURIComponent).join('/');}
  async list(){return this.client.propfind(this.url);}
  async read(name:string){return this.client.get(this.child(name));}
  async write(name:string,bytes:Uint8Array){await this.client.put(this.child(name),bytes,'application/octet-stream');}
  async exists(name:string){return this.client.exists(this.child(name));}
  async create(){if(!await this.client.exists(this.url))await this.client.mkcol(this.url);}
}
export class LocalStorage implements StoreStorage {
  readonly kind='local' as const;
  readonly identity:string;
  constructor(readonly directory:string){this.identity=path.resolve(directory);}
  private child(name:string){
    if(!name||name.split('/').some(p=>!p||p==='.'||p==='..')||name.includes('\\')||name.includes('\0')||(name.includes('/')&&!/^data\/[^/]+$/.test(name)))throw Error('Invalid store filename');
    return path.join(this.identity,name);
  }
  async list(){
    const entries=await fs.readdir(this.identity,{withFileTypes:true});
    return Promise.all(entries.filter(e=>!e.name.startsWith('.')).map(async e=>{
      if(e.isSymbolicLink())throw Error('Symbolic links are not allowed in the transaction store');
      const stat=await fs.stat(this.child(e.name));
      return {name:e.name,isCollection:e.isDirectory(),revision:`${stat.ino}:${stat.size}:${stat.mtimeMs}`};
    }));
  }
  async read(name:string){if(name.includes('/')&&(await fs.lstat(path.dirname(this.child(name)))).isSymbolicLink())throw Error('Symbolic links are not allowed');const handle=await fs.open(this.child(name),constants.O_RDONLY|constants.O_NOFOLLOW);try{return await handle.readFile();}finally{await handle.close();}}
  async exists(name:string){try{const s=await fs.lstat(this.child(name));if(s.isSymbolicLink())throw Error('Symbolic links are not allowed');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
  async create(){await fs.mkdir(this.identity,{recursive:true});}
  async write(name:string,bytes:Uint8Array){
    const destination=this.child(name),temporary=this.child('.mcp-'+crypto.randomUUID()+'.tmp');
    // Publish complete immutable transactions atomically; never overwrite another writer.
    const file=await fs.open(temporary,'wx',0o600);
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    try{if(name.endsWith('.client'))await fs.rename(temporary,destination);else await fs.link(temporary,destination);}finally{await fs.unlink(temporary).catch(()=>{});}
  }
}
