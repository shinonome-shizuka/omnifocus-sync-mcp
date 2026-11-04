import {AsyncLocalStorage} from 'node:async_hooks';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadConfig, type Config} from './config.js';
import {LocalStorage} from './storage/index.js';
import {OmniFocusStore} from './ofocus/store.js';
import {OmniFocusService} from './ofocus/service.js';

export type Backend='local'|'remote';
interface Scope {backend:Backend;service?:OmniFocusService;locked?:boolean}
const scope=new AsyncLocalStorage<Scope>();
export const currentBackend=():Backend=>scope.getStore()?.backend??'local';
export const localDirectory=()=>process.env.OMNIFOCUS_LOCAL_DATABASE??path.join(os.homedir(),'Library/Containers/com.omnigroup.OmniFocus4/Data/Library/Application Support/OmniFocus/OmniFocus.ofocus');
export function backendConfig(backend:Backend):Config {
  if(backend==='remote')return loadConfig();
  const directory=path.resolve(localDirectory()),key=crypto.createHash('sha256').update(directory).digest('hex');
  return {username:'',password:'',passphrase:process.env.OMNIFOCUS_ENCRYPTION_PASSPHRASE??process.env.OMNIFOCUS_SYNC_PASSWORD??'',syncBaseUrl:'',database:directory,ofocusUrl:directory,
    clientName:process.env.OMNIFOCUS_CLIENT_NAME??'omnifocus-sync-mcp-local',
    clientStateFile:process.env.OMNIFOCUS_LOCAL_CLIENT_STATE_FILE??path.join(process.env.OF_AGENT_STATE_DIR??path.join(os.homedir(),'.local/state/omnifocus-agent'),'clients',key+'.json'),
    readOnly:/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY??''),authScheme:'auto'};
}
export function backendService():OmniFocusService {
  const s=scope.getStore();if(s?.service)return s.service;
  const backend=currentBackend(),config=backendConfig(backend);
  const service=new OmniFocusService(config,backend==='local'?new OmniFocusStore(new LocalStorage(config.database)):undefined);
  if(s)s.service=service;return service;
}
/** Serialize our writers across processes; native/remote concurrent changes are fenced by store signatures. */
export async function withBackend<T>(backend:Backend,fn:()=>Promise<T>,write=false):Promise<T> {
  const existing=scope.getStore();
  if(existing?.backend===backend && (!write||existing.locked))return fn();
  const next:Scope={backend};
  return scope.run(next,async()=>{
    if(!write)return fn();
    const config=backendConfig(backend);
    if(config.readOnly)throw Error('Server is read-only (OMNIFOCUS_READ_ONLY)');
    await fs.mkdir(path.dirname(config.clientStateFile),{recursive:true,mode:0o700});
    const lockFile=config.clientStateFile+'.store-lock';
    // Reject contention rather than silently replaying a potentially uncertain mutation.
    await fs.mkdir(lockFile,{mode:0o700});
    try{await fs.writeFile(path.join(lockFile,'owner.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));next.locked=true;return await fn();}
    finally{await fs.rm(lockFile,{recursive:true,force:true});}
  });
}
/** Both MCP routes invoke exactly the same service methods in their request scope. */
export const sharedService=new Proxy({} as OmniFocusService,{get(_target,key){const service=backendService();const value=(service as any)[key];return typeof value==='function'?value.bind(service):value;}});
