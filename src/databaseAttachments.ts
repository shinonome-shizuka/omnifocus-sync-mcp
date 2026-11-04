import {unzipSync} from 'fflate';
import {backendService} from './backend.js';
import {Database} from './ofocus/database.js';
import {readLocalDatabase} from './localDatabase.js';
export function attachmentMetadata(db:Database,id:string,offset=0,limit=20){
 const all=[...db.attachments.values()].filter(a=>a.taskId===id).sort((a,b)=>a.id.localeCompare(b.id));
 return {attachments:all.slice(offset,offset+limit).map((a,i)=>({kind:'embedded',index:offset+i,attachmentId:a.id,name:a.name,type:'archive',readTool:'of_read_attachment'})),
 attachmentCount:all.length,embeddedAttachmentCount:all.length,linkedFileCount:null,attachmentPage:{offset,limit,total:all.length,nextOffset:offset+limit<all.length?offset+limit:null}};
}
export async function readDatabaseAttachment(a:any){
 const service=backendService(),db=await readLocalDatabase(),task=db.tasks.get(a.id);
 if(!task)throw Error('Action not found');
 if(task.modified!==a.expectedModified)throw Error('Task changed; refresh attachment list before reading');
 const attachments=[...db.attachments.values()].filter(x=>x.taskId===a.id).sort((x,y)=>x.id.localeCompare(y.id));
 const attachment=attachments[a.index];if(!attachment?.dataIdentifier)throw Error('Attachment data unavailable');
 const bytes=await service.readAttachmentData(attachment.dataIdentifier);
 const entries:{name:string;size:number}[]=[];
 unzipSync(bytes,{filter:f=>{if(f.name.split('/').some(p=>p==='..'))throw Error('Invalid archive path');entries.push({name:f.name,size:f.originalSize});return false;}});
 let prefix='';let name=attachment.name;
 // An archive with one file represents that file, irrespective of ZIP filename encoding.
 const files=entries.filter(e=>!e.name.endsWith('/'));
 if(files.length===1&&!files[0].name.includes('/')&&!a.childPath.length){
  if(a.expectedName!==name)throw Error('Attachment name changed; refresh before reading');
  const file=files[0];if(file.size>a.maxBytes)throw Error('Attachment exceeds maxBytes; no data returned');
  const data=unzipSync(bytes,{filter:f=>f.name===file.name})[file.name];
  return {id:a.id,index:a.index,name,kind:'file',modified:task.modified,sizeBytes:data.length,data:Buffer.from(data).toString('base64')};
 }
 const children=(base:string)=>[...new Set(entries.filter(e=>e.name.startsWith(base)).map(e=>e.name.slice(base.length).split('/')[0]).filter(Boolean))].sort();
 for(const index of a.childPath){const child=children(prefix)[index];if(child===undefined)throw Error('Attachment child not found');prefix+=child;name=child;if(entries.some(e=>e.name.startsWith(prefix+'/')))prefix+='/';}
 if(name!==a.expectedName)throw Error('Attachment name changed; refresh before reading');
 const file=entries.find(e=>e.name===prefix&&!e.name.endsWith('/'));
 if(file){if(file.size>a.maxBytes)throw Error('Attachment exceeds maxBytes; no data returned');const data=unzipSync(bytes,{filter:f=>f.name===file.name})[file.name];return {id:a.id,index:a.index,name,kind:'file',modified:task.modified,sizeBytes:data.length,data:Buffer.from(data).toString('base64')};}
 const list=children(prefix);return {id:a.id,index:a.index,name,kind:'directory',modified:task.modified,children:list.slice(a.offset,a.offset+a.limit).map((n,i)=>({index:a.offset+i,name:n,type:entries.some(e=>e.name.startsWith(prefix+n+'/'))?'directory':'file'})),total:list.length,nextOffset:a.offset+a.limit<list.length?a.offset+a.limit:null};
}
