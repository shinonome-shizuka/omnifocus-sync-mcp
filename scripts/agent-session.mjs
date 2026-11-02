import {update,reduce} from './session-state.mjs';
const [command,...args]=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2)opts[args[i].replace(/^--/,'')]=args[i+1];
const id=opts.session||process.env.CODEX_THREAD_ID;
if(command==='show')console.log(JSON.stringify(await update(id,s=>s),null,2));
else if(command==='resolve'){
 if(!['no_match','diagnostic','not_actionable','blocked'].includes(opts.status)||!opts.reason?.trim())throw Error('resolve requires --status no_match|diagnostic|not_actionable|blocked and --reason');
 await update(id,s=>reduce(s,{hook_event_name:'Resolve',status:opts.status,reason:opts.reason,turn_id:opts.turn}));console.log('Recorded binding decision; no OF state modified.');
}else throw Error('Use show or resolve');
