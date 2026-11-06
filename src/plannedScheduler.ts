#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeDatabasePath, readNativeDatabase } from './nativeDatabase.js';
import { activation, dispatchPlanned, plannedQueue } from './plannedDispatch.js';
import { root } from './monitor/runtime.js';

async function main(argv: string[]) {
  const split = argv.indexOf('--');
  const worker = split < 0 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({ args: split < 0 ? argv : argv.slice(0, split), options: {
    project: { type: 'string' }, run: { type: 'boolean' }, watch: { type: 'boolean' },
  } });
  const project = values.project;
  if (!project || (values.watch && !values.run) || Boolean(values.run) !== Boolean(worker.length))
    throw Error('Preview: --project PROJECT_ID. Enable: --project PROJECT_ID --run [--watch] -- codex exec -');
  if (values.run && /^(1|true|yes)$/i.test(process.env.OMNIFOCUS_READ_ONLY ?? '')) throw Error('Server is read-only');
  const file = nativeDatabasePath();
  if (!file) throw Error('Select the native OmniFocus SQLite source');
  const state = root();
  const first = await readNativeDatabase(file);
  if (!first.tasks.get(project)?.isProject) throw Error('Project ID not found');
  const since = await activation(state, project, !!values.run) ?? Date.now();
  const queue = async () => plannedQueue(await readNativeDatabase(file), state, project, since, Date.now());
  do {
    const tasks = await queue();
    if (!values.run) {
      console.log(JSON.stringify({ dryRun: true, project, since: new Date(since).toISOString(), tasks }, null, 2));
      return;
    }
    for (const candidate of tasks.filter(task => task.reason === 'ready')) {
      const result = await dispatchPlanned({ root: state, project, candidate, refresh: queue, launch: assignment =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(worker[0], worker.slice(1), { stdio: ['pipe','inherit','inherit'] });
          child.once('error', reject);
          child.once('close', (code, signal) => code === 0 ? resolve() : reject(Error('Worker exit ' + (signal ?? code))));
          child.stdin.on('error', () => {}); // An early exit is reported through close/error.
          child.stdin.end([
            'Execute this authorized planned OmniFocus Action via the ordinary AFK workflow.',
            JSON.stringify(assignment),
            'Read the Action via MCP. Recheck the exact planned date, project, availability and tags.',
            'Claim with of_agent_transition(event=start) using this exact id and runId. Only execute after confirmed success.',
            'On delivery or human intervention use done or needs_human with the same runId. For Codex include the actual codexThreadId.',
            'On refusal or uncertain outcome stop and report. Never replay or substitute a different runId.',
          ].join('\n'));
        }),
      });
      console.log(JSON.stringify(result));
      if (result.status === 'needs-inspection') process.exitCode = 1;
    }
    if (values.watch) await sleep(60_000);
  } while (values.watch);
}

main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
