import {Database} from './database.js';
import {handoffBody} from '../handoffLink.js';

/** Append only a new handoff while retaining the original rich text and cells. */
export function handoffNotePatch(db:Database,id:string,event:'done'|'needs_human',reason:string):{note?:string;noteMarkup?:string}{
 const task=db.tasks.get(id);if(!task)throw Error('Action not found');
 const original=task.note??'',handoff=(event==='done'?'交付：':'需要你处理：')+handoffBody(reason,event);
 if(original.endsWith(handoff))return {};
 const rich=db.richNoteMarkup(id);
 if(!rich)return {note:(original?original+'\n\n':'')+handoff};
 const escaped=handoff.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const paragraph=(original?'<p><run><lit></lit></run></p>':'')+'<p><run><lit>'+escaped+'</lit></run></p>';
 if(/<\/text\s*>/.test(rich))return {noteMarkup:rich.replace(/<\/text\s*>/,paragraph+'</text>')};
 if(/<text\s*\/>/.test(rich))return {noteMarkup:rich.replace(/<text\s*\/>/,'<text>'+paragraph+'</text>')};
 throw Error('Cannot preserve rich note; no transaction was written');
}
