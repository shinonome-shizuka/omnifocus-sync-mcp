import {z} from 'zod';
import {readDatabaseAttachment} from './databaseAttachments.js';
export function attachmentPageScript(offset=0,limit=20){
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid attachment page');
 return `const embedded=t.attachments||[],linked=t.linkedFileURLs||[],total=embedded.length+linked.length;
const attachments=[];for(let i=${offset};i<Math.min(total,${offset}+${limit});i++){
 if(i<embedded.length){const w=embedded[i];attachments.push({kind:'embedded',index:i,name:w.preferredFilename||w.filename||null,type:w.type===FileWrapper.Type.File?'file':w.type===FileWrapper.Type.Directory?'directory':'symbolic-link',childrenCount:w.type===FileWrapper.Type.Directory?(w.children||[]).length:0,readTool:'of_read_attachment'});}
 else{const u=linked[i-embedded.length];attachments.push({kind:'linked',index:i-embedded.length,url:u.absoluteString,readTool:null});}
}
const attachmentPage={offset:${offset},limit:${limit},total,nextOffset:${offset}+attachments.length<total?${offset}+attachments.length:null};`;
}
export function readAttachmentScript(a:any){
 if(!Number.isInteger(a.index)||a.index<0||!Number.isInteger(a.maxBytes)||a.maxBytes<1||a.maxBytes>4*1024*1024||!Array.isArray(a.childPath)||a.childPath.length>20||a.childPath.some((n:any)=>!Number.isInteger(n)||n<0))throw Error('Invalid attachment request');
 return `const a=${JSON.stringify(a)},t=flattenedTasks.find(t=>t.id.primaryKey===a.id);if(!t)throw Error('Action not found');
const revision=t.modified?t.modified.toISOString():null;if(revision!==a.expectedModified)throw Error('Task changed; refresh attachment list before reading');
let w=(t.attachments||[])[a.index];if(!w)throw Error('Attachment not found');
for(const i of a.childPath){if(w.type!==FileWrapper.Type.Directory)throw Error('Child path is not a directory');w=(w.children||[])[i];if(!w)throw Error('Attachment child not found');}
const name=w.preferredFilename||w.filename||null;
if(name!==a.expectedName)throw Error('Attachment name changed; refresh before reading');
if(w.type===FileWrapper.Type.Directory){const children=w.children||[];JSON.stringify({id:a.id,index:a.index,name,kind:'directory',modified:revision,children:children.slice(a.offset,a.offset+a.limit).map((c,i)=>({index:a.offset+i,name:c.preferredFilename||c.filename||null,type:c.type===FileWrapper.Type.Directory?'directory':c.type===FileWrapper.Type.File?'file':'symbolic-link'})),total:children.length,nextOffset:a.offset+a.limit<children.length?a.offset+a.limit:null});}
else{if(w.type!==FileWrapper.Type.File)throw Error('Symbolic links are not followed');const data=w.contents;if(!data||!Number.isFinite(data.length))throw Error('Attachment data unavailable locally');if(data.length>a.maxBytes)throw Error('Attachment exceeds maxBytes; no data returned');JSON.stringify({id:a.id,index:a.index,name,kind:'file',modified:revision,sizeBytes:data.length,data:data.toBase64()});}`;
}
export function attachmentResult(r:any){
 if(r.kind==='directory')return {content:[{type:'text',text:JSON.stringify(r)}]};
 const b=Buffer.from(r.data,'base64');let mimeType='application/octet-stream';
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mimeType='image/png';
 else if(b[0]===255&&b[1]===216&&b[2]===255)mimeType='image/jpeg';
 else if(['GIF87a','GIF89a'].includes(b.subarray(0,6).toString()))mimeType='image/gif';
 else if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')mimeType='image/webp';
 else if(b.subarray(0,5).toString()==='%PDF-')mimeType='application/pdf';
 const {data,...meta}=r;const content:any[]=[{type:'text',text:JSON.stringify({...meta,mimeType})}];
 if(mimeType.startsWith('image/'))content.push({type:'image',mimeType,data});
 else{const uri='omnifocus-attachment://task/'+encodeURIComponent(r.id)+'/'+r.index+'/'+encodeURIComponent(r.name||'attachment');let text:string|undefined;
  if(/\.(txt|md|csv|json|log|xml)$/i.test(r.name||'')){try{text=new TextDecoder('utf-8',{fatal:true}).decode(b);}catch{}}
  content.push({type:'resource',resource:text!==undefined?{uri,mimeType:'text/plain',text}:{uri,mimeType,blob:data}});
 }
 return {content};
}
export function registerAttachmentTools(register:any,error:any){register('of_read_attachment',{description:'Read one embedded attachment on demand. Requires modified timestamp and name from task detail; default 1 MiB, maximum 4 MiB. Directory children are paginated; linked files and symlinks are not followed. Returns native MCP image/resource content.',inputSchema:{id:z.string().min(1),index:z.number().int().min(0),expectedModified:z.string().nullable(),expectedName:z.string().nullable(),childPath:z.array(z.number().int().min(0)).max(20).default([]),maxBytes:z.number().int().min(1).max(4*1024*1024).default(1024*1024),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(20)}},async(a:any)=>{try{return attachmentResult(await readDatabaseAttachment(a));}catch(e){return error(e);}});}
