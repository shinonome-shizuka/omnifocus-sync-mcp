import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const files=['test','scripts'].flatMap(dir=>fs.readdirSync(dir).filter(n=>/\.test\.(ts|mjs)$/.test(n)&&!['ledger-mcp.test.ts','ledger-adapters.test.ts','ownership-ledger.test.ts'].includes(n)).map(n=>dir+'/'+n));
execFileSync(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit'});
