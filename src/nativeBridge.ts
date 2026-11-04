import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** Execute a named native operation via of-cli. Never fall back to database writes. */
export async function nativeWrite(operation:string,args:unknown):Promise<any>{
  if(/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY??''))throw Error('Server is read-only');
  const cli=process.env.OMNIFOCUS_CLI_PATH||fileURLToPath(new URL('../../omnifocus-cli/dist/cli.js',import.meta.url));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'mcp','native-write'],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
    child.stdout.setEncoding('utf8').on('data',data=>stdout+=data);
    child.stderr.setEncoding('utf8').on('data',data=>stderr+=data);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{
      clearTimeout(timer);
      if(code!==0){reject(Error(`of-cli native write failed; outcome may be uncertain, inspect before retry: ${stderr.trim()||'process terminated'}`));return;}
      try{const value=JSON.parse(stdout);if(!value||Array.isArray(value)||typeof value!=='object'||value.ok===false||value.error)throw Error('Invalid or rejected native response');resolve({...value,writeMode:'app',databaseVisibility:'not-verified'});}catch{reject(Error('of-cli returned invalid or rejected JSON; inspect before retry'));}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({operation,args}));
  });
}
