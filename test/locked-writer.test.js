import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// Integration: actual reflection ledger -> real Core memory writer and lock ->
// private memory files. The live-run observer is injected as a constant in the
// public writer CLI API; no tmux server, service, network or runtime is touched.
// Run when writer/ledger absorption changes; skip unrelated fetch/scheduler work.
test('real locked writer rejects active Sync and absorbs evidence only after publication', t => {
  assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to a Core checkout');
  const core = fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ZYLOS_PACKAGE_ROOT: core };
  for (const [key, name] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'instance', ZYLOS_DATA_DIR: 'data', PM2_HOME: 'pm2', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(root, name); fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"codex","session_mode":"multi"}');
  const memory = path.join(env.ZYLOS_DIR, 'memory'); fs.mkdirSync(memory);
  const identity = path.join(memory, 'identity.md');
  const original = '# Identity\n\n## Personality & Behavioral Traits\nCheck evidence.\n\n## Other\nStable.\n';
  fs.writeFileSync(identity, original);
  fs.writeFileSync(path.join(memory, 'references.md'), '# References\n');
  const proposed = path.join(root, 'proposed.md');
  fs.writeFileSync(proposed, original.replace('Check evidence.', 'Check evidence and context.'));
  const writer = path.join(root, 'writer.mjs');
  const coreWriter = pathToFileURL(path.join(core, 'skills/zylos-memory/scripts/memory-write.js')).href;
  fs.writeFileSync(writer, `import {runMemoryWriteCli} from ${JSON.stringify(coreWriter)}; process.exitCode=await runMemoryWriteCli(process.argv.slice(2), {currentRunId: async()=> 'fixture-run'});`);
  const rotation = path.join(root, 'rotation.mjs');
  fs.writeFileSync(rotation, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'rotation-requested'))},process.argv.slice(2).join(' '));`);
  const config = { identity_file: identity, memory_writer: writer, rotation_script: rotation, ledger_min_groups: 2, ledger_min_dates: 2, ledger_expiry_days: 60 };
  const markerDir = path.join(env.ZYLOS_DIR, 'activity-monitor/session-groups/origin');
  fs.mkdirSync(markerDir, { recursive: true });
  const marker = path.join(markerDir, 'sync.lock');
  fs.writeFileSync(marker, JSON.stringify({ runId: 'fixture-run', kind: 'group', token: 'a'.repeat(32), expiresAt: Date.now() + 60000 }));
  const module = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/ledger.js')).href;
  const evidence = [ { type: 'missing-context', date: '2026-11-15', session_group: 'telegram:a', c4_id: 1, quote: 'Read the context.' }, { type: 'missing-context', date: '2026-11-16', session_group: 'dashboard:b', c4_id: 2, quote: 'You missed the context again.' } ];
  const options = { file: proposed, sha256: crypto.createHash('sha256').update(original).digest('hex'), types: ['missing-context'] };
  function invoke(source) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import * as ledger from ${JSON.stringify(module)}; const config=${JSON.stringify(config)}; ${source}`], { env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, (child.stdout + child.stderr).slice(0, 1000));
    return JSON.parse(child.stdout);
  }
  const rejected = invoke(`ledger.appendErrors(${JSON.stringify(evidence)},config); console.log(JSON.stringify(ledger.writeIdentity(${JSON.stringify(options)},config)));`);
  assert.equal(rejected.status, 'write_deferred');
  assert.match(rejected.writer.output, /SYNC_BUSY/);
  assert.equal(fs.readFileSync(identity, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(root, 'rotation-requested')), false);
  const before = fs.readFileSync(path.join(env.ZYLOS_DATA_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(before.length, 2);
  assert.ok(before.every(row => !row.absorbed));
  fs.unlinkSync(marker);
  const success = invoke(`console.log(JSON.stringify(ledger.writeIdentity(${JSON.stringify(options)},config)));`);
  assert.equal(success.status, 'updated');
  assert.equal(fs.readFileSync(identity, 'utf8'), fs.readFileSync(proposed, 'utf8'));
  const absorbed = fs.readFileSync(path.join(env.ZYLOS_DATA_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(absorbed.every(row => row.absorbed));
  assert.equal(fs.readFileSync(path.join(root, 'rotation-requested'), 'utf8'), '--reason identity');
});
