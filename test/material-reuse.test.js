import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkpointFixture } from './helpers/checkpoint-fixture.js';

// Integration: real shared producer code -> saved thinking-patterns material ->
// reflection CLI -> real Core checkpoint metadata in private SQLite. Run when
// cross-component artifact/consumer contracts change; skip unrelated identity
// wording and scheduler changes. All instance/service paths are checked by the
// fixture before use; child processes have deadlines and owned cleanup.
test('reflection reuses correction evidence without fetching original material again', t => {
  const f = checkpointFixture(t);
  f.row(1, 'telegram:a', 'Please correct the unsupported claim.');
  f.row(2, 'telegram:a', 'I will check the source.', 'telegram', 'out');
  f.row(3, 'telegram:a', 'Use source evidence for decisions.');
  f.checkpoint(1, 'telegram:a', 1, 3);
  const root = path.resolve(import.meta.dirname, '..');
  const module = pathToFileURL(path.join(root, 'scripts/materials.js')).href;
  const producer = `import * as materials from ${JSON.stringify(module)};
    const config=${JSON.stringify(f.config)};
    const run=materials.collectMaterials(config,{}, {now:Date.parse('2026-11-16T02:00:00Z'),zylos_dir:process.env.ZYLOS_DIR,time_zone:'UTC'});
    materials.traceMaterials(config,{},run,[{session_group:'telegram:a',c4_id:1,kind:'correction'},{session_group:'telegram:a',c4_id:3,kind:'decision'}]);
    materials.saveArtifact(${JSON.stringify(path.join(f.env.ZYLOS_DIR, 'components/thinking-patterns/materials'))},run);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', producer], { env: f.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  const log = path.join(f.root, 'fetch-calls.jsonl');
  const proxy = path.join(f.root, 'fetch-proxy.mjs');
  fs.writeFileSync(proxy, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
    const child=spawnSync(process.execPath,[${JSON.stringify(f.config.c4_fetch_cli)},...process.argv.slice(2)],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
    process.stdout.write(child.stdout||''); process.stderr.write(child.stderr||''); process.exitCode=child.status??1;`);
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify({ ...f.config, c4_fetch_cli: proxy }));
  const result = JSON.parse(f.invoke(path.join(root, 'scripts/reflect.js'), ['fetch']));
  assert.equal(result.status, 'ready');
  assert.equal(result.report.reused_ranges, 1);
  assert.equal(result.report.inbound.count, 0);
  assert.equal(result.report.sessions.count, 0);
  assert.equal(result.clues.length, 1);
  assert.equal(result.clues[0].kind, 'correction');
  assert.equal(result.clues[0].c4_id, 1);
  assert.equal(result.traces.length, 1);
  assert.equal(result.trace_complete, true);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(args => args.includes('--checkpoints')));
});

// Same isolated real Core/SQLite boundary (temporary HOME, ZYLOS_DIR, PM2_HOME,
// TMPDIR and C4 database; never live resources). Run when prefix reuse or range
// collection changes; skip unrelated ledger, wording and scheduler changes.
test('a checkpoint after the producer run reuses its range and collects only newer rows', t => {
  const f = checkpointFixture(t);
  f.row(1, 'telegram:a', 'Please correct the unsupported claim.');
  f.row(2, 'telegram:a', 'I will check the source.', 'telegram', 'out');
  f.row(3, 'telegram:a', 'Use source evidence for decisions.');
  f.checkpoint(1, 'telegram:a', 1, 3);
  const root = path.resolve(import.meta.dirname, '..');
  const module = pathToFileURL(path.join(root, 'scripts/materials.js')).href;
  const producer = `import * as materials from ${JSON.stringify(module)};
    const config=${JSON.stringify(f.config)};
    const run=materials.collectMaterials(config,{}, {now:Date.parse('2026-11-16T02:00:00Z'),zylos_dir:process.env.ZYLOS_DIR,time_zone:'UTC'});
    materials.traceMaterials(config,{},run,[{session_group:'telegram:a',c4_id:1,kind:'correction'}]);
    materials.saveArtifact(${JSON.stringify(path.join(f.env.ZYLOS_DIR, 'components/thinking-patterns/materials'))},run);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', producer], { env: f.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  // The thread syncs again after the producer ran.
  f.row(4, 'telegram:a', 'Newer message after the producer run.');
  f.row(5, 'telegram:a', 'Another newer message.');
  f.checkpoint(2, 'telegram:a', 4, 5);
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(f.config));
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), JSON.stringify({ schema_version: 2, groups: { 'telegram:a': { end_conversation_id: 0, checkpoint_id: 0 } }, pending_clues: [] }));
  const result = JSON.parse(f.invoke(path.join(root, 'scripts/reflect.js'), ['fetch']));
  assert.equal(result.report.partially_reused_ranges, 1);
  assert.deepEqual(result.report.reuse_misses, []);
  assert.deepEqual(result.ranges.map(r => [r.after, r.end, r.reused_through]), [[0, 5, 3]]);
  assert.deepEqual(result.inbound.map(row => row.id), [4, 5]);
  assert.deepEqual(result.clues.map(c => c.c4_id), [1]);
  assert.equal(result.trace_complete, false);
});

// Same isolated real Core/SQLite boundary. Run when inbound filters or artifact
// compatibility change; skip unrelated ledger, wording and scheduler changes.
test('reflection recollects old artifacts without the scheduled task filter', t => {
  const f = checkpointFixture(t);
  f.row(1, 'telegram:a', '[Scheduled Task: task-1 #1] machine prompt');
  f.row(2, 'telegram:a', 'quoted [Scheduled Task: task-1 #1] retained');
  f.sql(`UPDATE conversations SET timestamp='${new Date().toISOString()}'`);
  f.checkpoint(1, 'telegram:a', 1, 2);
  const root = path.resolve(import.meta.dirname, '..');
  const module = pathToFileURL(path.join(root, 'scripts/materials.js')).href;
  const producer = `import * as materials from ${JSON.stringify(module)};
    const run=materials.collectMaterials(${JSON.stringify(f.config)},{}, {zylos_dir:process.env.ZYLOS_DIR,time_zone:'UTC'});
    materials.traceMaterials(${JSON.stringify(f.config)},{},run,[]);
    delete run.filters.exclude_scheduled_tasks;
    materials.saveArtifact(${JSON.stringify(path.join(f.env.ZYLOS_DIR, 'components/thinking-patterns/materials'))},run);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', producer], { env: f.env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr);
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(f.config));
  const result = JSON.parse(f.invoke(path.join(root, 'scripts/reflect.js'), ['fetch']));
  assert.equal(result.report.reused_ranges, 0);
  assert.equal(result.report.reuse_misses[0].reason, 'filters_mismatch');
  assert.equal(result.inbound.length, 1);
  assert.equal(result.inbound[0].id, 2);
  assert.equal(result.filters.exclude_scheduled_tasks, true);
});
