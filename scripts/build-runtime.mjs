import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'dist');
const temp=await fs.mkdtemp(path.join(root,'.runtime-build-'));
try{
 execFileSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'--project',path.join(root,'tsconfig.json'),'--outDir',temp],{stdio:'inherit'});
 let s=await fs.readFile(path.join(temp,'localWorkflow.js'),'utf8');
 const ast=ts.createSourceFile('localWorkflow.js',s,ts.ScriptTarget.Latest,true);
 const n=ast.statements.find(n=>n.name?.text==='transition');if(!n)throw Error('Transition export missing');
 s=s.slice(0,n.getStart(ast))+"export {transition} from './legacyTransition.js';"+s.slice(n.end);
 await fs.writeFile(path.join(temp,'localWorkflow.js'),s);
 for(const name of ['index.js','legacyTransition.js'])await fs.copyFile(path.join(root,'runtime',name),path.join(temp,name));
 // v2 is staged, never shipped by the default production build.
 await fs.rm(path.join(temp,'ledger'),{recursive:true,force:true});
 await fs.mkdir(out,{recursive:true});await fs.rm(path.join(out,'ledger'),{recursive:true,force:true});await fs.cp(temp,out,{recursive:true});
 console.log('Built legacy runtime with native status fixes; v2 excluded:',out);
}finally{await fs.rm(temp,{recursive:true,force:true});}
