import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const key=(id:string)=>crypto.createHash('sha256').update(id).digest('hex');
export async function read(file:string):Promise<any>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as any).code==='ENOENT')return null;throw e;}}
export async function save(file:string,value:any){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';const h=await fs.open(tmp,'wx',0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}await fs.rename(tmp,file);}
export async function lock<T>(root:string,id:string,fn:()=>Promise<T>){await fs.mkdir(root,{recursive:true,mode:0o700});const file=path.join(root,'transition-'+key(id)+'.lock');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify({pid:process.pid,mode:'monitor'}));return await fn();}finally{await h.close();await fs.unlink(file);}}
