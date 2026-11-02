import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {Database} from './ofocus/database.js';
import {DocumentKey,parseEncryptionMetadata,decryptFile} from './crypto/index.js';
const directory=process.env.OMNIFOCUS_LOCAL_DATABASE??path.join(os.homedir(),'Library/Containers/com.omnigroup.OmniFocus4/Data/Library/Application Support/OmniFocus/OmniFocus.ofocus');
let cache:{signature:string,db:Database}|undefined;
export async function readLocalDatabase(){
 for(let attempt=0;attempt<3;attempt++){
 const files=(await fs.readdir(directory)).filter(n=>/^\d{14}=.+\.zip$/.test(n)).sort();
 if(!files.some(n=>n.startsWith('00000000000000=')))throw Error('Local OmniFocus baseline missing');
 const stamp=async()=>JSON.stringify(await Promise.all(files.map(async n=>{const s=await fs.stat(path.join(directory,n));return [n,s.size,s.mtimeMs];})));
 const signature=await stamp();if(cache?.signature===signature)return cache.db;
 let key:DocumentKey|null=null;
 try{const meta=await fs.readFile(path.join(directory,'encrypted'));const pass=process.env.OMNIFOCUS_ENCRYPTION_PASSPHRASE??process.env.OMNIFOCUS_SYNC_PASSWORD;if(!pass)throw Error('Local store requires encryption passphrase');key=DocumentKey.fromMetadata(parseEncryptionMetadata(meta),pass);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const db=new Database();
 for(const name of files){let bytes=await fs.readFile(path.join(directory,name));if(key)bytes=Buffer.from(decryptFile(key,name,bytes));const xml=unzipSync(bytes)['contents.xml'];if(!xml)throw Error('Missing contents.xml: '+name);db.applyTransaction(strFromU8(xml));}
 const after=(await fs.readdir(directory)).filter(n=>/^\d{14}=.+\.zip$/.test(n)).sort();if(JSON.stringify(files)!==JSON.stringify(after)||signature!==await stamp())continue;
 cache={signature,db};return db;
 }
 throw Error('Local database changed during read; retry');
}
export async function localViews(){const db=await readLocalDatabase();return db.allTaskViews().map(t=>{let status=t.status;let n=db.tasks.get(t.id);const visited=new Set<string>();while(n){if(visited.has(n.id))throw Error('Cyclic task ancestry');visited.add(n.id);if(n.droppedDate||n.projectStatus==='dropped'){status='dropped';break;}if(n.completed||n.projectStatus==='done')status='completed';n=n.parentId?db.tasks.get(n.parentId):undefined;}return {...t,status,completionDate:t.completed,completed:status==='completed',dropped:status==='dropped',tags:t.tagNames,project:t.projectName,backend:'local-database'};});}
