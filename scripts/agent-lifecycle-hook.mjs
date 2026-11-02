import {input,sessionId,update,reduce} from './session-state.mjs';
let payload;
try{payload=await input();await update(sessionId(payload),s=>reduce(s,payload));console.log('{}');}catch(e){const reason='OmniFocus session recording failed: '+e.message;console.log(JSON.stringify(payload?.hook_event_name==='PreToolUse'?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}}:{systemMessage:reason}));}
