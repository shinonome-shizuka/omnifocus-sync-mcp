import rrule from 'rrule';
export interface RepetitionInput {
 rule:string;
 method?:'fixed'|'start-after-completion'|'due-after-completion';
 anchor?:'due'|'defer'|'planned';
 catchUpAutomatically?:boolean;
}
/** Validates a single RRULE without expanding unbounded occurrences. */
export function repetitionElements(input:RepetitionInput|null):string[]{
 if(input===null)return ['<repetition-rule/>','<repetition-method/>','<repetition-schedule-type/>','<repetition-anchor-date/>','<catch-up-automatically>false</catch-up-automatically>'];
 const rule=input.rule.trim().replace(/^RRULE:/i,'').toUpperCase();
 if(!rule || rule.length>2048 || !/^[A-Z0-9=;,\-+]+$/.test(rule))throw new Error('Expected one RRULE without DTSTART or newlines');
 const keys=rule.split(';').map(p=>p.split('=')[0]);
 if(new Set(keys).size!==keys.length || !keys.includes('FREQ'))throw new Error('RRULE needs one FREQ and no duplicate fields');
 if(keys.includes('COUNT') && keys.includes('UNTIL'))throw new Error('Use COUNT or UNTIL, not both');
 const parsed=rrule.RRule.fromString(rule);
 if(!Number.isInteger(parsed.options.interval) || parsed.options.interval<1)throw new Error('Repeat interval must be positive');
 if(parsed.options.count!==null && (!Number.isInteger(parsed.options.count)||parsed.options.count<1))throw new Error('Repeat count must be positive');
 const method=input.method??'fixed';
 const anchor=input.anchor??(method==='start-after-completion'?'defer':'due');
 if(!['fixed','start-after-completion','due-after-completion'].includes(method))throw new Error('Unsupported repetition method');
 if(!['due','defer','planned'].includes(anchor))throw new Error('Unsupported repetition anchor');
 if(method==='start-after-completion' && anchor!=='defer' || method==='due-after-completion' && anchor!=='due')throw new Error('Completion-based method and anchor must match');
 if(method!=='fixed' && input.catchUpAutomatically)throw new Error('Catch-up applies only to fixed schedules');
 const date={due:'dateDue',defer:'dateToStart',planned:'datePlanned'}[anchor];
 return [`<repetition-rule>${rule}</repetition-rule>`,`<repetition-method>${method}</repetition-method>`,`<repetition-schedule-type>${method==='fixed'?'from-assigned':'from-completion'}</repetition-schedule-type>`,`<repetition-anchor-date>${date}</repetition-anchor-date>`,`<catch-up-automatically>${input.catchUpAutomatically??false}</catch-up-automatically>`];
}
