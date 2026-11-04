const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function handoffBody(reason:string,event?:string):string {
 let body=reason.trim();
 const prefix=event==='done'?/^(?:交付\s*[:：]\s*)+/:event==='needs_human'?/^(?:需要你处理\s*[:：]\s*)+/:null;
 if(prefix)body=body.replace(prefix,'').trim();
 if(!body)throw Error('Handoff reason required');
 return body;
}
export function handoffReason(reason:string,identity:any):string {
 const body=handoffBody(reason,identity.event);
 const actor=identity.actor||identity;
 let id=identity.codexThreadId;
 if(!id&&actor.platform==='codex')id=actor.sessionId;
 if(!id){const match=/^codex[-:]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[-:]|$)/i.exec(identity.runId||'');id=match?.[1];}
 if(!id){if(/^codex[-:]/i.test(identity.runId||''))throw Error('Codex handoff requires codexThreadId; abbreviated runId is not a chat ID');return body;}
 if(!uuid.test(id))throw Error('Codex chat ID must be a UUID');
 const url='codex://threads/'+id.toLowerCase();
 return body.split(/\s+/).includes(url)?body:body+'\nCodex 对话：'+url;
}
