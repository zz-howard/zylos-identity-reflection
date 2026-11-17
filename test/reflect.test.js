import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'scripts/reflect.js');
const fixtureCli = path.join(ROOT, 'test/helpers/cli-fixture.js');
const fixtureMemory = path.join(ROOT, 'test/helpers/memory-fixture.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// These CLI integration cases run only private fixtures and temporary files.
// Run when reflection state, ledger, identity writes or hook migration changes;
// skip only when none of those boundaries changed. No daemon, tmux or DB starts.
function fixture(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const zylos = path.join(home, 'zylos'), data = path.join(zylos, 'components/identity-reflection');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(home, 'tmp'));
  fs.mkdirSync(path.join(zylos, 'memory'), { recursive: true });
  const statePath = path.join(home, 'fixture.json'), calls = path.join(home, 'calls');
  fs.writeFileSync(statePath, JSON.stringify({ groups: [], rows: [], checkpoints: [], tasks: [] }));
  fs.writeFileSync(calls, '');
  const identity = path.join(zylos, 'memory/identity.md');
  fs.writeFileSync(identity, '# Identity\n\n## Who I Am\nPiper\n\n## Personality & Behavioral Traits\nOld trait.\n\n## Principles\nCare.\n');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, ZYLOS_DATA_DIR: data, PM2_HOME: path.join(home, 'pm2'), TMPDIR: path.join(home, 'tmp'), TMUX_TMPDIR: path.join(home, 'tmp'), FIXTURE_STATE: statePath, FIXTURE_CALLS: calls, TZ: 'UTC' };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ c4_db_cli: fixtureCli, c4_fetch_cli: fixtureCli, memory_writer: fixtureMemory, rotation_script: fixtureMemory, ...config }));
  function invoke(args, extra = {}, script = CLI) {
    // Read back all process destinations before every invocation.
    for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(home));
    const child = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(child.error, undefined);
    return { code: child.status, value: script === CLI ? JSON.parse(child.stdout) : child.stdout, stderr: child.stderr };
  }
  const json = (name, value) => { const file = path.join(home, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const set = value => fs.writeFileSync(statePath, JSON.stringify(value));
  return { home, zylos, data, identity, env, calls, invoke, json, set };
}
function errorRow(group, date, id, type = 'premature-conclusion') { return { type, date, session_group: group, c4_id: id, quote: 'Please verify before concluding.' }; }
function append(f, rows) { return f.invoke(['ledger', 'append', '--file', f.json('errors.json', rows)]); }
function proposal(f, body = 'Verify evidence before concluding.') {
  const before = fs.readFileSync(f.identity, 'utf8');
  const file = path.join(f.home, 'proposal.md');
  fs.writeFileSync(file, before.replace('Old trait.', body));
  return ['write-identity', '--file', file, '--sha256', hash(before), '--types', f.json('types.json', ['premature-conclusion'])];
}

test('ledger requires distinct dates in any threads and deduplicates evidence', t => {
  const f = fixture(t);
  // An older config may still carry a thread threshold; it no longer applies.
  const configFile = path.join(f.data, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile)), ledger_min_groups: 2 }));
  const a = errorRow('A', '2026-11-14', 10), b = errorRow('A', '2026-11-14', 11);
  assert.equal(append(f, [a, b, a]).value.added, 2);
  assert.equal(f.invoke(['ledger', 'list']).value.thresholds[0].eligible, false);
  assert.equal(f.invoke(proposal(f)).code, 1);
  append(f, [errorRow('A', '2026-11-15', 12)]);
  assert.equal(f.invoke(['ledger', 'list']).value.thresholds[0].eligible, true);
  assert.equal(f.invoke(['ledger', 'absorb', '--type', a.type]).code, 1);
});

test('locked identity write preserves other sections, absorbs evidence and requests rotation', t => {
  const f = fixture(t);
  append(f, [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)]);
  const args = proposal(f);
  const result = f.invoke(args);
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'updated');
  assert.equal(result.value.rotation.status, 'rotation_requested');
  assert.match(fs.readFileSync(f.identity, 'utf8'), /## Who I Am\nPiper/);
  assert.match(fs.readFileSync(f.calls, 'utf8'), /rotation/);
  assert.ok(f.invoke(['ledger', 'list']).value.entries.every(row => row.absorbed));
  append(f, [errorRow('C', '2026-11-16', 12)]);
  f.invoke(['ledger', 'absorb', '--type', 'premature-conclusion']);
  assert.equal(f.invoke(['ledger', 'list']).value.entries.at(-1).absorbed, false);
});

test('busy memory sync preserves identity, errors and thread progress for retry', t => {
  const f = fixture(t);
  append(f, [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)]);
  f.json('unused.json', {});
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ schema_version: 2, groups: { A: { end_conversation_id: 20, checkpoint_id: 2 } }, pending_clues: [] }));
  const before = fs.readFileSync(f.identity, 'utf8');
  const args = proposal(f), refused = f.invoke(args, { FIXTURE_SYNC_BUSY: '1' });
  assert.equal(refused.value.status, 'write_deferred');
  assert.match(refused.value.writer.output, /SYNC_BUSY/);
  assert.equal(fs.readFileSync(f.identity, 'utf8'), before);
  assert.ok(f.invoke(['ledger', 'list']).value.entries.every(row => !row.absorbed));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'))).groups.A.end_conversation_id, 20);
  assert.equal(f.invoke(args).value.status, 'updated');
});

test('fetch reports pending absorption and rotation without new checkpoint progress', t => {
  const f = fixture(t);
  append(f, [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)]);
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ schema_version: 2, groups: {}, pending_clues: [], rotation_pending: true }));
  const result = f.invoke(['fetch']).value;
  assert.equal(result.status, 'skip');
  assert.equal(result.pending_error_types.length, 1);
  assert.equal(result.pending_error_types[0], 'premature-conclusion');
  assert.equal(result.rotation_pending, true);
  assert.equal(f.invoke(proposal(f)).value.status, 'updated');
  assert.equal(f.invoke(['fetch']).value.pending_error_types.length, 0);
});

test('identity rejects stale hashes, outside-section changes, missing section and over-budget content', t => {
  const f = fixture(t);
  append(f, [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)]);
  const args = proposal(f);
  const stale = [...args]; stale[stale.indexOf('--sha256') + 1] = '0'.repeat(64);
  assert.match(f.invoke(stale).value.error, /hash changed/);
  const file = args[args.indexOf('--file') + 1], original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Piper', 'Changed identity'));
  assert.match(f.invoke(args).value.error, /Only Personality/);
  fs.writeFileSync(file, original.replace('## Personality & Behavioral Traits', '## Other'));
  assert.match(f.invoke(args).value.error, /section is missing/);
  fs.writeFileSync(file, original.replace('Verify evidence before concluding.', 'x'.repeat(17000)));
  assert.match(f.invoke(args).value.error, /16 KiB/);
});

test('rotation rejection stays pending and legacy writer is explicitly reported', t => {
  const f = fixture(t, { memory_writer: '/missing/writer.js' });
  append(f, [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)]);
  const result = f.invoke(proposal(f), { FIXTURE_ROTATION_REJECT: '1' }).value;
  assert.equal(result.writer.mode, 'legacy');
  assert.equal(result.rotation.status, 'rotation_deferred');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'))).rotation_pending, true);
  assert.equal(f.invoke(['rotation']).value.status, 'rotation_requested');
});

test('ledger rejects narratives and expires only types absent beyond retention', t => {
  const f = fixture(t);
  assert.equal(append(f, [{ ...errorRow('A', '2026-11-14', 10), quote: 'First line\nsecond line' }]).code, 1);
  append(f, [errorRow('A', '2000-01-01', 1, 'old'), errorRow('A', new Date().toISOString().slice(0, 10), 2, 'recent')]);
  assert.equal(f.invoke(['ledger', 'clean']).value.removed, 1);
  assert.equal(f.invoke(['ledger', 'list']).value.entries[0].type, 'recent');
});

test('quiet fetch expires old eligible types before proposing identity changes', t => {
  const f = fixture(t);
  append(f, [errorRow('A', '2000-01-01', 1), errorRow('B', '2000-01-02', 2)]);
  assert.equal(f.invoke(proposal(f)).code, 1);
  append(f, [errorRow('A', '2000-01-01', 1), errorRow('B', '2000-01-02', 2)]);
  const result = f.invoke(['fetch']).value;
  assert.equal(result.status, 'skip');
  assert.equal(result.pending_error_types.length, 0);
  assert.equal(f.invoke(['ledger', 'list']).value.entries.length, 0);
});

test('fetch reconciles an interrupted successful identity write before retrying rotation', t => {
  const f = fixture(t);
  const errors = [errorRow('A', '2026-11-14', 10), errorRow('B', '2026-11-15', 11)];
  append(f, errors);
  const args = proposal(f), replacement = fs.readFileSync(args[args.indexOf('--file') + 1]);
  const evidence = errors.map(row => hash(JSON.stringify([row.type, row.date, row.session_group, row.c4_id])));
  const intent = JSON.stringify({ schema_version: 2, groups: {}, pending_clues: [], identity_write_pending: { file: f.identity, sha256: hash(replacement), types: ['premature-conclusion'], evidence } });
  fs.writeFileSync(path.join(f.data, 'state.json'), intent);
  // A saved intent alone must never authorize absorption or rotation; an
  // unapplied intent is dropped so it cannot linger as an unfinished write.
  const before = f.invoke(['fetch']).value;
  assert.equal(before.rotation_pending, false);
  assert.ok(f.invoke(['ledger', 'list']).value.entries.every(row => !row.absorbed));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'))).identity_write_pending, undefined);
  fs.writeFileSync(path.join(f.data, 'state.json'), intent);
  fs.writeFileSync(f.identity, replacement);
  const recovered = f.invoke(['fetch']).value;
  assert.equal(recovered.rotation_pending, true);
  assert.equal(recovered.pending_error_types.length, 0);
  assert.ok(f.invoke(['ledger', 'list']).value.entries.every(row => row.absorbed));
  assert.equal(f.invoke(['rotation']).value.status, 'rotation_requested');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'))).identity_write_pending, undefined);
});

test('unsupported checkpoint Core explicitly skips and preserves old cursor without using it', t => {
  const f = fixture(t);
  f.set({ groups: ['A'], unsupported: true });
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ last_processed_id: 999999 }));
  const result = f.invoke(['fetch']).value;
  assert.equal(result.status, 'skip');
  assert.equal(result.mode, 'unsupported_core');
  assert.match(result.reason, /checkpoint/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'state.json'))).last_processed_id, 999999);
});

test('reflection reuses matching corrections without raw reads and fills uncovered thread ranges', t => {
  const f = fixture(t);
  const now = new Date().toISOString();
  const cachedDir = path.join(f.zylos, 'components/thinking-patterns/materials');
  fs.mkdirSync(cachedDir, { recursive: true });
  const clue = { session_group: 'A', c4_id: 10, kind: 'correction' };
  const filters = { channels: null, exclude_channels: ['internal', 'system', 'void', 'multica'], exclude_scheduled_tasks: true };
  fs.writeFileSync(path.join(cachedDir, 'abcdef.json'), JSON.stringify({ schema_version: 1, run_id: 'abcdef', created_at: now, trace_complete: true, filters, ranges: [{ session_group: 'A', after: 0, end: 10, checkpoint_id: 1 }], clues: [clue, { ...clue, kind: 'decision' }], traces: [{ clue, rows: [] }], trace_report: { clues: 1, deferred: 0 } }));
  f.set({ groups: ['A'], checkpoints: [{ id: 1, session_group: 'A', start_conversation_id: 1, end_conversation_id: 10 }], rows: [] });
  const reused = f.invoke(['fetch']).value;
  assert.equal(reused.status, 'ready');
  assert.equal(reused.report.reused_ranges, 1);
  assert.equal(reused.inbound.length, 0);
  assert.equal(reused.session_files.length, 0);
  assert.equal(reused.clues.length, 1);
  assert.equal(reused.clues[0].kind, 'correction');
  assert.equal(reused.trace_report.clues, 1);
  assert.ok(reused.trace_report.bytes > 0);
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /--since|--begin/);
  assert.equal(f.invoke(['commit', '--run', reused.run_id, '--result', 'no_change']).code, 0);
  f.set({ groups: ['A', 'B'], checkpoints: [{ id: 1, session_group: 'A', start_conversation_id: 1, end_conversation_id: 10 }, { id: 2, session_group: 'B', start_conversation_id: 11, end_conversation_id: 20 }], rows: [{ id: 20, session_group: 'B', channel: 'telegram', direction: 'in', timestamp: now, content: 'Please verify this conclusion.' }] });
  const filled = f.invoke(['fetch']).value;
  assert.equal(filled.ranges.length, 1);
  assert.equal(filled.ranges[0].session_group, 'B');
  assert.equal(filled.inbound.length, 1);
  assert.equal(filled.inbound[0].id, 20);
  assert.equal(f.invoke(['commit', '--run', filled.run_id, '--result', 'no_change']).code, 1);
  assert.equal(f.invoke(['trace', '--run', filled.run_id, '--clues', f.json('clues.json', [])]).code, 0);
  assert.equal(f.invoke(['commit', '--run', filled.run_id, '--result', 'no_change']).code, 0);
  const state = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json')));
  assert.equal(state.groups.A.end_conversation_id, 10);
  assert.equal(state.groups.B.end_conversation_id, 20);
});

test('first upgraded reflection ignores old global backlog and only reads the recent day', t => {
  const f = fixture(t);
  const now = new Date().toISOString();
  f.set({ groups: ['*'], checkpoints: [{ id: 1, session_group: '*', start_conversation_id: 1, end_conversation_id: 20 }], rows: [{ id: 10, session_group: '*', channel: 'telegram', direction: 'in', timestamp: '2000-01-01T00:00:00Z', content: 'Old backlog' }, { id: 20, session_group: '*', channel: 'telegram', direction: 'in', timestamp: now, content: 'Recent correction' }] });
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ schema_version: 1, last_processed_id: 1 }));
  const result = f.invoke(['fetch']).value;
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.inbound.length, 1);
  assert.equal(result.inbound[0].id, 20);
  const state = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json')));
  assert.equal(state.schema_version, 2);
  assert.equal(state.last_processed_id, undefined);
});

test('reflection carries bounded deferred clues into fresh checkpoint ranges', t => {
  const f = fixture(t, { trace_max_clues: 1, trace_context: 1 });
  const timestamp = new Date().toISOString();
  f.set({ groups: ['A', 'B'], checkpoints: [
    { id: 1, session_group: 'A', end_conversation_id: 10 },
    { id: 2, session_group: 'B', end_conversation_id: 20 }
  ], rows: [
    { id: 10, session_group: 'A', timestamp, channel: 'telegram', direction: 'in', content: 'Correction A' },
    { id: 20, session_group: 'B', timestamp, channel: 'telegram', direction: 'in', content: 'Correction B' }
  ] });
  const run = f.invoke(['fetch']).value;
  const clues = f.json('clues.json', ['A', 'B'].map((session_group, i) => ({ session_group, c4_id: (i + 1) * 10, kind: 'correction' })));
  assert.equal(f.invoke(['trace', '--clues', clues]).value.trace_report.deferred, 1);
  assert.equal(f.invoke(['trace', '--clues', f.json('empty.json', [])]).value.traces.length, 1);
  assert.equal(f.invoke(['commit', '--result', 'no_change', '--groups', 'A,B']).code, 0);
  f.set({ groups: ['A', 'B'], checkpoints: [
    { id: 1, session_group: 'A', end_conversation_id: 10 },
    { id: 2, session_group: 'B', end_conversation_id: 20 },
    { id: 3, session_group: 'A', end_conversation_id: 30 }
  ], rows: [
    { id: 20, session_group: 'B', timestamp, channel: 'telegram', direction: 'in', content: 'Correction B' },
    { id: 30, session_group: 'A', timestamp, channel: 'telegram', direction: 'in', content: 'New correction A' }
  ] });
  const resumed = f.invoke(['fetch']).value;
  assert.notEqual(resumed.run_id, run.run_id);
  assert.equal(resumed.ranges[0].end, 30);
  assert.equal(resumed.inbound[0].id, 30);
  const artifactFile = path.join(f.data, 'materials', `${run.run_id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(artifactFile)).committed, true);
  assert.equal(f.invoke(['trace', '--clues', f.json('empty.json', [])]).value.traces[0].clue.c4_id, 20);
  assert.equal(f.invoke(['commit', '--result', 'no_change']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(artifactFile)).committed, true);
  assert.equal(f.invoke(['trace', '--run', run.run_id, '--clues', f.json('empty.json', [])]).code, 1);
  assert.equal(f.invoke(['fetch']).value.status, 'skip');
  const log = fs.readFileSync(path.join(f.data, 'logs/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(log.trace_report.deferred, 0);
  assert.equal(log.report.inbound.count, 1);
  const expired = JSON.parse(fs.readFileSync(artifactFile));
  expired.created_at = '2000-01-01T00:00:00Z';
  fs.writeFileSync(artifactFile, JSON.stringify(expired));
  f.set({ groups: ['A'], checkpoints: [{ id: 4, session_group: 'A', end_conversation_id: 31 }], rows: [
    { id: 31, session_group: 'A', timestamp, channel: 'telegram', direction: 'in', content: 'Next material' }
  ] });
  f.invoke(['fetch']);
  assert.equal(fs.existsSync(artifactFile), false);
});

test('hooks remove stale managed tasks including paused duplicates and preserve user tasks', t => {
  const f = fixture(t);
  const scheduler = path.join(f.zylos, '.claude/skills/scheduler/scripts');
  fs.mkdirSync(scheduler, { recursive: true });
  fs.copyFileSync(fixtureCli, path.join(scheduler, 'cli.js'));
  const prompt = 'Run the identity-reflection skill. Load and follow ~/zylos/.claude/skills/identity-reflection/SKILL.md. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.';
  f.set({ tasks: [
    { id: 'old', name: 'identity-reflection', prompt, status: 'pending', cron_expression: '0 0,12 * * *' },
    { id: 'paused', name: 'identity-reflection', prompt, status: 'paused', cron_expression: '0 0,12 * * *' },
    { id: 'user', name: 'identity-reflection', prompt: 'My custom reflection', status: 'pending', cron_expression: '0 3 * * *' },
    { id: 'thinking', name: 'thinking-patterns', prompt: 'Read patterns', status: 'pending', cron_expression: '50 23 * * *' }
  ] });
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ last_processed_id: 8000 }));
  const hook = path.join(ROOT, 'hooks/post-upgrade.js');
  assert.equal(f.invoke([], {}, hook).code, 0);
  fs.writeFileSync(path.join(f.data, 'policy.md'), 'Owner policy remains intact.');
  assert.equal(f.invoke([], {}, path.join(ROOT, 'hooks/post-install.js')).code, 0);
  assert.equal(fs.readFileSync(path.join(f.data, 'policy.md'), 'utf8'), 'Owner policy remains intact.');
  const tasks = JSON.parse(fs.readFileSync(f.env.FIXTURE_STATE)).tasks;
  assert.equal(tasks.length, 3);
  assert.equal(tasks.filter(task => task.name === 'identity-reflection' && task.prompt === prompt).length, 1);
  assert.equal(tasks.find(task => task.id === 'new-task').cron_expression, '30 0 * * *');
  assert.equal(tasks.find(task => task.id === 'user').cron_expression, '0 3 * * *');
  assert.equal(tasks.find(task => task.id === 'thinking').cron_expression, '50 23 * * *');
  const state = JSON.parse(fs.readFileSync(path.join(f.data, 'state.json')));
  assert.equal(state.schema_version, 2);
  assert.equal(state.last_processed_id, undefined);
  assert.equal(Object.keys(state.groups).length, 0);
  const calls = fs.readFileSync(f.calls, 'utf8');
  assert.match(calls, /remove.*old/);
  assert.match(calls, /remove.*paused/);
  assert.ok(calls.trim().split('\n').map(line => JSON.parse(line)).every(call => call[0] !== 'pause'));
});

const FILTERS = { channels: null, exclude_channels: ['internal', 'system', 'void', 'multica'], exclude_scheduled_tasks: true };
// Private fixture CLI integration: run for artifact reuse, trace-budget or
// scope changes; skip unrelated scheduling. No live database or service starts.
for (const group of ['A', '*']) test(`partial producer corrections reuse ${group} with an independent trace budget`, t => {
  const f = fixture(t, { trace_max_clues: 1, trace_context: 1 });
  const ranges = [{ session_group: group, after: 0, end: 3, checkpoint_id: 1 }, ...(group === '*' ? [] : [{ session_group: 'B', after: 0, end: 4, checkpoint_id: 2 }])];
  const clue = id => ({ session_group: group, c4_id: id, kind: 'correction' });
  const traced = clue(1), deferred = clue(2), other = { ...clue(3), kind: 'decision' };
  const dir = path.join(f.zylos, 'components/thinking-patterns/materials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abcdef01.json'), JSON.stringify({ run_id: 'abcdef01', created_at: new Date().toISOString(), trace_complete: false, filters: FILTERS, ranges, clues: [traced, deferred, other], deferred_clues: [deferred, other], traces: [{ clue: traced, rows: [], report: { characters: 0 } }], trace_report: { clues: 1, deferred: 2 } }));
  f.set({ groups: ranges.map(r => r.session_group), checkpoints: ranges.map((r, i) => ({ id: i + 1, session_group: r.session_group, end_conversation_id: r.end })), rows: [1, 2, 3].map(id => ({ id, session_group: group, timestamp: new Date().toISOString(), channel: 'telegram', direction: 'in', content: `Correction ${id}` })) });
  const fetched = f.invoke(['fetch']).value;
  assert.equal(fetched.report.reused_ranges, ranges.length);
  assert.equal(fetched.report.reuse_misses.length, 0);
  assert.equal(fetched.report.inbound.count, 0);
  assert.equal(fetched.report.sessions.count, 0);
  assert.equal(fetched.clues.length, 2);
  assert.equal(fetched.trace_complete, false);
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /--since|--begin/);
  const result = f.invoke(['trace', '--clues', f.json('empty.json', [])]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.traces.length, 2);
  assert.equal(result.value.trace_complete, true);
  assert.equal(result.value.report.supplemental_traces, 1);
  assert.equal(result.value.traces.at(-1).clue.c4_id, 2);
  assert.equal(f.invoke(['commit', '--result', 'no_change']).code, 0);
});
test('reused trace bytes do not consume the reflection byte allowance', t => {
  const f = fixture(t, { trace_max_clues: 5, trace_context: 1, trace_max_bytes: 2000 });
  const ranges = [{ session_group: 'A', after: 0, end: 3, checkpoint_id: 1 }];
  const clue = id => ({ session_group: 'A', c4_id: id, kind: 'correction' });
  const dir = path.join(f.zylos, 'components/thinking-patterns/materials');
  fs.mkdirSync(dir, { recursive: true });
  const large = { clue: clue(1), rows: [{ id: 1, content: 'x'.repeat(5000) }], report: { characters: 5000 } };
  fs.writeFileSync(path.join(dir, 'abcdef01.json'), JSON.stringify({ run_id: 'abcdef01', created_at: new Date().toISOString(), trace_complete: false, filters: FILTERS, ranges, clues: [clue(1), clue(2), clue(3)], deferred_clues: [clue(2), clue(3)], traces: [large], trace_report: { clues: 1, deferred: 2 } }));
  f.set({ groups: ['A'], checkpoints: [{ id: 1, session_group: 'A', end_conversation_id: 3 }], rows: [1, 2, 3].map(id => ({ id, session_group: 'A', timestamp: new Date().toISOString(), channel: 'telegram', direction: 'in', content: `Correction ${id}` })) });
  assert.equal(f.invoke(['fetch']).value.report.reused_ranges, 1);
  const result = f.invoke(['trace', '--clues', f.json('empty.json', [])]).value;
  assert.equal(result.report.supplemental_traces, 2);
  assert.equal(result.trace_report.deferred, 0);
});
test('deferred decisions alone do not block correction reuse', t => {
  const f = fixture(t);
  const ranges = [{ session_group: 'A', after: 0, end: 3, checkpoint_id: 1 }];
  tpArtifact(f, ranges);
  const file = path.join(f.zylos, 'components/thinking-patterns/materials/abcdef01.json');
  const material = JSON.parse(fs.readFileSync(file));
  material.trace_complete = false;
  material.clues = material.deferred_clues = [{ session_group: 'A', c4_id: 3, kind: 'decision' }];
  fs.writeFileSync(file, JSON.stringify(material));
  f.set({ groups: ['A'], checkpoints: [{ id: 1, session_group: 'A', end_conversation_id: 3 }], rows: [] });
  const fetched = f.invoke(['fetch']).value;
  assert.equal(fetched.trace_complete, true);
  assert.equal(fetched.clues.length, 0);
  assert.equal(fetched.report.reused_ranges, 1);
  assert.doesNotMatch(fs.readFileSync(f.calls, 'utf8'), /--since|--begin/);
});
test('only an incompatible range is recollected beside a partially traced producer', t => {
  const f = fixture(t);
  tpArtifact(f, [{ session_group: 'A', after: 0, end: 3, checkpoint_id: 1 }, { session_group: 'B', after: 0, end: 4, checkpoint_id: 2 }]);
  const file = path.join(f.zylos, 'components/thinking-patterns/materials/abcdef01.json');
  const material = JSON.parse(fs.readFileSync(file)); material.trace_complete = false; fs.writeFileSync(file, JSON.stringify(material));
  f.set({ groups: ['A', 'B'], checkpoints: [{ id: 1, session_group: 'A', end_conversation_id: 3 }, { id: 2, session_group: 'B', end_conversation_id: 5 }], rows: [{ id: 5, session_group: 'B', channel: 'telegram', direction: 'in', timestamp: new Date().toISOString(), content: 'Correction' }] });
  const fetched = f.invoke(['fetch']).value;
  assert.equal(fetched.report.reused_ranges, 1);
  assert.equal(fetched.report.reuse_misses.length, 1);
  assert.equal(fetched.report.reuse_misses[0].session_group, 'B');
  assert.equal(fetched.report.reuse_misses[0].reason, 'range_mismatch');
  assert.equal(fetched.inbound.length, 1);
  assert.equal(fetched.inbound[0].session_group, 'B');
});
test('producer artifacts reuse only after clue selection and only this range\'s corrections', t => {
  const f = fixture(t);
  const ranges = [{ session_group: 'A', after: 0, end: 3, checkpoint_id: 1 }, { session_group: 'B', after: 2, end: 4, checkpoint_id: 2 }];
  const dir = path.join(f.zylos, 'components/thinking-patterns/materials'); fs.mkdirSync(dir, { recursive: true });
  const correction = (group, id) => ({ session_group: group, c4_id: id, kind: 'correction' });
  const save = (id, extra) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ schema_version: 1, run_id: id, created_at: new Date().toISOString(), filters: FILTERS, clues: [], traces: [], trace_complete: false, ...extra }));
  // A: fetched but never traced. B: the producer also carried an older B clue (#2) from its own pending list.
  save('aaaa0001', { ranges: [ranges[0]] });
  save('bbbb0002', { ranges: [ranges[1]], clues: [correction('B', 2), correction('B', 4)], traces: [{ clue: correction('B', 4), rows: [], report: { characters: 0 } }], trace_report: { clues: 1, deferred: 1 }, deferred_clues: [correction('B', 2)] });
  f.set({ groups: ['A', 'B'], checkpoints: ranges.map(r => ({ id: r.checkpoint_id, session_group: r.session_group, end_conversation_id: r.end })), rows: [{ id: 2, session_group: 'A', channel: 'telegram', direction: 'in', timestamp: new Date().toISOString(), content: 'Correction' }] });
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ schema_version: 2, groups: { B: { end_conversation_id: 2, checkpoint_id: 0 } }, pending_clues: [] }));
  const fetched = f.invoke(['fetch']).value;
  assert.deepEqual(fetched.report.reuse_misses, [{ session_group: 'A', reason: 'clue_selection_unfinished' }]);
  assert.equal(fetched.report.reused_ranges, 1);
  assert.deepEqual(fetched.clues.map(c => `${c.session_group}:${c.c4_id}`), ['B:4']);
  assert.equal(fetched.inbound.length, 1);
  assert.equal(fetched.inbound[0].session_group, 'A');
});
function tpArtifact(f, ranges) {
  const dir = path.join(f.zylos, 'components/thinking-patterns/materials'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'abcdef01.json'), JSON.stringify({ schema_version: 1, run_id: 'abcdef01', created_at: new Date().toISOString(), trace_complete: true, filters: FILTERS, ranges, clues: [], traces: [], trace_report: { clues: 0, deferred: 0 } }));
}
test('pending clues keep a fully reused run incomplete until traced', t => {
  const f = fixture(t);
  const now = new Date().toISOString();
  tpArtifact(f, [{ session_group: 'A', after: 5, end: 10, checkpoint_id: 2 }]);
  f.set({ groups: ['A'], checkpoints: [{ id: 2, session_group: 'A', end_conversation_id: 10 }], rows: [{ id: 5, session_group: 'A', channel: 'telegram', direction: 'in', timestamp: now, content: 'Earlier correction' }] });
  fs.writeFileSync(path.join(f.data, 'state.json'), JSON.stringify({ schema_version: 2, groups: { A: { end_conversation_id: 5, checkpoint_id: 1 } }, pending_clues: [{ session_group: 'A', c4_id: 5, kind: 'correction', source_range: { session_group: 'A', after: 0, end: 5, checkpoint_id: 1 } }] }));
  const fetched = f.invoke(['fetch']).value;
  assert.equal(fetched.report.reused_ranges, 1);
  assert.equal(fetched.trace_complete, false);
  assert.equal(f.invoke(['commit', '--run', fetched.run_id, '--result', 'no_change']).code, 1);
});
test('a run mixing a reused and an uncovered thread needs tracing before commit', t => {
  const f = fixture(t);
  const now = new Date().toISOString();
  tpArtifact(f, [{ session_group: 'A', after: 0, end: 10, checkpoint_id: 1 }]);
  f.set({ groups: ['A', 'B'], checkpoints: [{ id: 1, session_group: 'A', end_conversation_id: 10 }, { id: 2, session_group: 'B', end_conversation_id: 20 }], rows: [{ id: 20, session_group: 'B', channel: 'telegram', direction: 'in', timestamp: now, content: 'Please verify this conclusion.' }] });
  const fetched = f.invoke(['fetch']).value;
  assert.equal(fetched.report.reused_ranges, 1);
  assert.equal(fetched.trace_complete, false);
  assert.equal(f.invoke(['commit', '--run', fetched.run_id, '--result', 'no_change']).code, 1);
});
test('a paused copy of the current task is replaced by one pending task', t => {
  const f = fixture(t);
  const scheduler = path.join(f.zylos, '.claude/skills/scheduler/scripts');
  fs.mkdirSync(scheduler, { recursive: true });
  fs.copyFileSync(fixtureCli, path.join(scheduler, 'cli.js'));
  const prompt = 'Run the identity-reflection skill. Load and follow ~/zylos/.claude/skills/identity-reflection/SKILL.md. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.';
  f.set({ tasks: [
    { id: 'paused-current', name: 'identity-reflection', prompt, status: 'paused', cron_expression: '30 0 * * *' },
    { id: 'live', name: 'identity-reflection', prompt, status: 'pending', cron_expression: '30 0 * * *' }
  ] });
  assert.equal(f.invoke([], {}, path.join(ROOT, 'hooks/post-upgrade.js')).code, 0);
  const tasks = JSON.parse(fs.readFileSync(f.env.FIXTURE_STATE)).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[0].cron_expression, '30 0 * * *');
});
