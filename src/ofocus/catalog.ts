import {Database} from './database.js';
import {createId} from '../crypto/index.js';
const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export type CatalogInput={kind:'folder'|'tag';operation:'create'|'update'|'delete';id?:string;name?:string;parentId?:string|null};
export function planCatalog(db:Database,input:CatalogInput){
 const map=input.kind==='folder'?db.folders:db.tags,element=input.kind==='folder'?'folder':'context';
 const id=input.operation==='create'?createId():input.id;
 if(!id)throw Error('ID required');
 if(input.operation!=='create'&&!map.has(id))throw Error('Object not found');
 if(input.operation==='create'&&!input.name?.trim())throw Error('Name required');
 if(input.name!==undefined&&!input.name.trim())throw Error('Name must not be blank');
 if(input.parentId){
  if(!map.has(input.parentId))throw Error('Parent not found');
  const seen=new Set([id]);let current:string|null=input.parentId;
  while(current){if(seen.has(current))throw Error('Hierarchy cycle');seen.add(current);current=map.get(current)?.parentId??null;}
 }
 if(input.operation==='delete'){
  if([...map.values()].some(x=>x.parentId===id))throw Error('Move children before deleting');
  const used=[...db.tasks.values()].some(t=>input.kind==='folder'?t.projectFolderId===id:db.tagIdsForTask(t.id,t.primaryTagId).includes(id));
  if(used)throw Error('Object is in use; remove references before deleting');
 }
 const body:string[]=[];
 if(input.name!==undefined)body.push(`<name>${esc(input.name.trim())}</name>`);
 if(input.parentId!==undefined)body.push(input.parentId?`<${element} idref="${esc(input.parentId)}"/>`:`<${element}/>`);
 if(input.operation==='create')body.push('<rank>2147480000</rank>');
 const op=input.operation==='create'?'':` op="${input.operation}"`;
 const xml=`<omnifocus xmlns="http://www.omnigroup.com/namespace/OmniFocus/v2"><${element} id="${esc(id)}"${op}>${body.join('')}</${element}></omnifocus>`;
 return {id,xml};
}
