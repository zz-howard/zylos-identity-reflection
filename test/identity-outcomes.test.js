import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
// Integration boundary: real ledger/state and CLI logging, private files and
// fixture writer/rotation subprocesses. Run for identity closure or recovery;
// skip unrelated material collection. No DB, socket, service or network used.
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-outcome-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const [key, name] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'instance', ZYLOS_DATA_DIR: 'data', PM2_HOME: 'pm2', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(temporary, name);
    fs.mkdirSync(env[key]);
    assert.ok(fs.realpathSync(env[key]).startsWith(temporary + path.sep), key);
  }
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  const memory = path.join(env.ZYLOS_DIR, 'memory'); fs.mkdirSync(memory);
  const identity = path.join(memory, 'identity.md');
  const original = '# Identity\n\n## Personality & Behavioral Traits\nCheck evidence.\n\n## Other\nStable.\n';
  const replacement = original.replace('Check evidence.', 'Check evidence and context.');
  fs.writeFileSync(identity, original);
  const proposal = path.join(temporary, 'proposal.md'); fs.writeFileSync(proposal, replacement);
  env.FIXTURE_CALLS = path.join(temporary, 'calls');
  const config = { memory_writer: path.join(root, 'test/helpers/memory-fixture.js'), rotation_script: path.join(root, 'test/helpers/memory-fixture.js') };
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(config));
  const module = pathToFileURL(path.join(root, 'scripts/ledger.js')).href;
  const settings = pathToFileURL(path.join(root, 'scripts/settings.js')).href;
  function run(source, extra = {}) {
    for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(fs.realpathSync(env[key]).startsWith(temporary + path.sep));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as ledger from ${JSON.stringify(module)}; import {loadConfig} from ${JSON.stringify(settings)}; const config=loadConfig(); ${source}`], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stderr + result.stdout).slice(0, 1000));
    return result.stdout ? JSON.parse(result.stdout) : undefined;
  }
  function cli(args) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/reflect.js'), ...args], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stderr + result.stdout).slice(0, 1000));
    return JSON.parse(result.stdout);
  }
  const evidence = [
    { type: 'missing-context', date: '2026-11-15', session_group: 'A', c4_id: 1, quote: 'Read context.' },
    { type: 'missing-context', date: '2026-11-16', session_group: 'B', c4_id: 2, quote: 'Read context again.' }
  ];
  const options = { file: proposal, sha256: digest(original), types: ['missing-context'] };
  const stateFile = path.join(env.ZYLOS_DATA_DIR, 'state.json');
  return { env, original, replacement, identity, evidence, options, run, cli,
    state: () => JSON.parse(fs.readFileSync(stateFile)),
    setState: value => fs.writeFileSync(stateFile, JSON.stringify({ schema_version: 2, ...value })),
    rows: () => fs.readFileSync(path.join(env.ZYLOS_DATA_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    seed: () => run(`ledger.appendErrors(${JSON.stringify(evidence)},config);`),
    write: extra => run(`console.log(JSON.stringify(ledger.writeIdentity(${JSON.stringify(options)},config)));`, extra)
  };
}

test('already-covered closure requires current identity and eligible evidence without changing identity', t => {
  const f = fixture(t); f.seed(); f.setState({ active_run: 'coverage-run' });
  const options = { types: ['missing-context'], sha256: digest(f.original), reason: 'Identity already covers checking context' };
  const reject = value => f.run(`try { ledger.coverErrors(${JSON.stringify(value)},config); } catch(error) { console.log(JSON.stringify({error:error.message})); }`);
  assert.match(reject({ ...options, sha256: 'stale' }).error, /hash changed/);
  assert.match(reject({ ...options, types: ['new-type'] }).error, /threshold/);
  assert.match(reject({ ...options, reason: '' }).error, /reason/);
  assert.ok(f.rows().every(row => !row.absorbed));
  const result = f.run(`console.log(JSON.stringify(ledger.coverErrors(${JSON.stringify(options)},config)));`);
  assert.equal(result.absorbed, 2);
  for (const row of f.rows()) {
    assert.equal(row.absorbed, true);
    assert.equal(row.absorption_reason, options.reason);
    assert.equal(row.identity_sha256, options.sha256);
  }
  assert.equal(fs.readFileSync(f.identity, 'utf8'), f.original);
  assert.equal(fs.existsSync(f.env.FIXTURE_CALLS), false);
  assert.equal(f.state().identity_outcome.status, 'already_covered');
  assert.equal(f.state().identity_outcome.run_id, 'coverage-run');
  assert.equal(f.run('console.log(JSON.stringify(ledger.listErrors(undefined,config)));').thresholds[0].eligible, false);
});

test('standalone write refusal is logged once and later commits explicitly report no write', t => {
  const f = fixture(t); f.seed();
  f.write({ FIXTURE_SYNC_BUSY: '1' });
  f.cli(['commit', '--result', 'skip']);
  f.cli(['commit', '--result', 'skip']);
  const logs = fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'logs/runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].identity_write.status, 'rejected');
  assert.equal(logs[0].identity_write.reason, 'SYNC_BUSY');
  assert.equal(logs[0].identity_write.mode, 'core');
  assert.equal(logs[0].identity_write.rotation.status, 'not_requested');
  assert.equal(logs[1].identity_write.status, 'not_written');
  assert.equal(logs[1].identity_write.mode, 'none');
  assert.equal(logs[1].identity_write.reason, null);
});

test('standalone successful legacy write logs writer mode and deferred rotation reason', t => {
  const f = fixture(t); f.seed();
  const configFile = path.join(f.env.ZYLOS_DATA_DIR, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile));
  config.memory_writer = path.join(f.env.HOME, 'unavailable-writer.js');
  fs.writeFileSync(configFile, JSON.stringify(config));
  f.write({ FIXTURE_ROTATION_REJECT: '1' });
  f.cli(['commit', '--result', 'skip']);
  const log = JSON.parse(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'logs/runs.jsonl'), 'utf8'));
  assert.equal(log.identity_write.status, 'written');
  assert.equal(log.identity_write.mode, 'legacy');
  assert.equal(log.identity_write.rotation.status, 'deferred');
  assert.equal(log.identity_write.rotation.reason, 'TRANSITION_OPEN');
});

test('core publication and covered closure each produce explicit committed run records', t => {
  const written = fixture(t); written.seed(); written.write();
  written.cli(['commit', '--result', 'skip']);
  const record = f => JSON.parse(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'logs/runs.jsonl'), 'utf8'));
  assert.equal(record(written).identity_write.status, 'written');
  assert.equal(record(written).identity_write.mode, 'core');
  assert.equal(record(written).identity_write.rotation.status, 'requested');
  const covered = fixture(t); covered.seed();
  covered.cli(['ledger', 'cover', '--types', '["missing-context"]', '--sha256', digest(covered.original), '--reason', 'Identity already covers context']);
  covered.cli(['commit', '--result', 'skip']);
  assert.equal(record(covered).identity_write.status, 'already_covered');
  assert.equal(record(covered).identity_write.mode, 'none');
  assert.equal(record(covered).identity_write.rotation.status, 'not_requested');
});

test('rejected writer clears unchanged pending intent and preserves evidence with refusal outcome', t => {
  const f = fixture(t); f.seed(); f.setState({ active_run: 'rejected-run' });
  const result = f.write({ FIXTURE_SYNC_BUSY: '1' });
  assert.equal(result.status, 'write_deferred');
  assert.equal(f.state().identity_write_pending, undefined);
  assert.ok(f.rows().every(row => !row.absorbed));
  assert.equal(fs.readFileSync(f.identity, 'utf8'), f.original);
  const outcome = f.state().identity_outcome;
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.mode, 'core');
  assert.equal(outcome.reason, 'SYNC_BUSY');
  assert.equal(outcome.rotation.status, 'not_requested');
});

test('writer refusal after publication recovers absorption and requests rotation', t => {
  const f = fixture(t); f.seed(); f.setState({ active_run: 'published-run' });
  const result = f.write({ FIXTURE_REJECT_AFTER_WRITE: '1' });
  assert.equal(result.status, 'updated');
  assert.equal(result.recovered, true);
  assert.equal(f.state().identity_write_pending, undefined);
  assert.ok(f.rows().every(row => row.absorbed));
  assert.equal(fs.readFileSync(f.identity, 'utf8'), f.replacement);
  assert.equal(f.state().identity_outcome.status, 'written');
  assert.equal(f.state().identity_outcome.mode, 'core');
  assert.equal(f.state().identity_outcome.rotation.status, 'requested');
});

test('a concurrent identity edit rejects the write without retaining an unapplied intent', t => {
  const f = fixture(t); f.seed();
  const result = f.write({ FIXTURE_IDENTITY_CONFLICT: '1' });
  assert.equal(result.status, 'write_deferred');
  assert.equal(f.state().identity_write_pending, undefined);
  assert.equal(f.state().identity_outcome.reason, 'MEMORY_CONFLICT');
  assert.ok(f.rows().every(row => !row.absorbed));
  assert.match(fs.readFileSync(f.identity, 'utf8'), /Concurrent edit/);
  assert.equal(fs.existsSync(f.env.FIXTURE_CALLS), false);
});

test('write outcomes retain deferred rotation reason and stay scoped to their run', t => {
  const f = fixture(t); f.seed(); f.setState({ active_run: 'written-run' });
  const result = f.write({ FIXTURE_ROTATION_REJECT: '1' });
  assert.equal(result.status, 'updated');
  const outcome = f.state().identity_outcome;
  assert.equal(outcome.rotation.status, 'deferred');
  assert.equal(outcome.rotation.reason, 'TRANSITION_OPEN');
  const other = f.run(`console.log(JSON.stringify(ledger.identityOutcomeForRun(${JSON.stringify(f.state())},'next-run')));`);
  assert.equal(other.status, 'not_written');
  assert.equal(other.mode, 'none');
  assert.equal(other.rotation.status, 'not_requested');
});
