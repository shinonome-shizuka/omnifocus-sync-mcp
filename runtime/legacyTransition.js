import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {scheduledClaim} from './plannedDispatch.js';
import {getLiveTask} from './localWorkflow.js';
import {validateLegacyTransition,writeWorkflow} from './workflowWrites.js';
import {handoffReason} from './handoffLink.js';
const state=process.env.OF_AGENT_STATE_DIR||path.join(os.homedir(),'.local/state/omnifocus-agent');
async function atomic(file,data){const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(data),{mode:0o600});await fs.rename(tmp,file);}
export async function transition(input) {
    if (/^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY ?? ''))
        throw Error('Server is read-only');
    if (!input.runId?.trim() || input.runId.length > 160 || !['start', 'done', 'needs_human'].includes(input.event) || !input.id)
        throw Error('Invalid transition');
    if (input.event !== 'start' && !input.reason?.trim())
        throw Error('Handoff reason required');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const lock = path.join(state, 'transition-' + crypto.createHash('sha256').update(input.id).digest('hex') + '.lock');
    // Exclusive task lock. Stale locks are retained for explicit inspection rather than unsafe takeover.
    const handle = await fs.open(lock, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.close();
    try {
        const dirs = ['local-ownership', 'pending'];
        for (const d of dirs)
            await fs.mkdir(path.join(state, d), { recursive: true, mode: 0o700 });
        const key = crypto.createHash('sha256').update(input.id).digest('hex');
        const ownerFile = path.join(state, 'local-ownership', key + '.json'), pending = path.join(state, 'pending', key + '.json');
        let owner;
        try {
            owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        const task = await getLiveTask(input.id);
        const scheduled = await scheduledClaim(state, input, task);
        let intent;
        try {
            intent = JSON.parse(await fs.readFile(ownerFile + '.intent', 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        if (intent && (intent.input.runId !== input.runId || intent.input.event !== input.event || intent.input.reason !== input.reason))
            throw Error('A prior local transition needs recovery with its original request');
        // Import existing local ownership records by exact Action ID, without a sync-server read.
        if (!owner) {
            const dir = path.join(state, 'ownership');
            const files = await fs.readdir(dir).catch(() => []);
            const candidates = [];
            for (const f of files) {
                const r = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
                if (r.events?.some((e) => e.id === input.id))
                    candidates.push(r.latest);
            }
            if (candidates.length > 1)
                throw Error('Multiple ownership records require review');
            owner = candidates[0];
        }
        if (!owner) {
            const records = [...task.note.matchAll(/\[of-agent:([A-Za-z0-9_-]+)\]/g)];
            if (records.length)
                owner = JSON.parse(Buffer.from(records.at(-1)[1], 'base64url').toString());
        }
        // Validate ownership before recording intent. The intent authorizes only this exact retry.
        if (intent)
            throw Error('Previous write outcome uncertain; automatic replay disabled to preserve human edits');
        else {
            if (scheduled && owner && !['done','needs_human','checked'].includes(owner.event)) throw Error('Scheduled Action already owned');
            const replay=validateLegacyTransition(input,owner,task);
            if(replay)return replay;
            await atomic(ownerFile + '.intent', { recoveryVersion: 1, before: task, input, previousOwner: owner ?? null });
        }
        await atomic(pending, { ...input, backend: 'local', requestedAt: new Date().toISOString() });
        const result = await writeWorkflow(input.id,input.event,scheduled ? {...task, scheduled} : task,input.event==='start'?undefined:handoffReason(input.reason,input));
        await atomic(ownerFile, { id: input.id, runId: input.runId, event: input.event, at: new Date().toISOString(), reason: input.reason || '' });
        await fs.unlink(pending);
        await fs.unlink(ownerFile + '.intent');
        return result;
    }
    catch (e) {
        const intent = path.join(state, 'local-ownership', crypto.createHash('sha256').update(input.id).digest('hex') + '.json.intent');
        const uncertain = await fs.access(intent).then(() => true, () => false);
        return { ok: false, id: input.id, event: input.event, status: uncertain ? 'uncertain' : 'rejected', ...(uncertain ? {recoveryTool:'of_agent_reconcile',nextAction:'inspect the original intent; do not replay the write'} : {}), error: String(e) };
    }
    finally {
        await fs.unlink(lock);
    }
}