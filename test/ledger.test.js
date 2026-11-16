import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
// CLI integration uses private memory/state and fixture subprocesses only.
// Run for ledger budgets, rotation reporting or argument parsing changes;
// skip unrelated material collection changes. No daemon, tmux or DB starts.
function fixture(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ir-ledger-')));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const [key, name] of Object.entries({ HOME: 'home', ZYLOS_DIR: 'instance', ZYLOS_DATA_DIR: 'data', PM2_HOME: 'pm2', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(temporary, name);
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(temporary + path.sep), key);
  }
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  const memory = path.join(env.ZYLOS_DIR, 'memory');
  fs.mkdirSync(memory);
  const identity = path.join(memory, 'identity.md');
  const original = '# Identity\n\n## Personality & Behavioral Traits\nOld trait.\n\n## Other\nStable.\n';
  fs.writeFileSync(identity, original);
  env.FIXTURE_CALLS = path.join(temporary, 'calls');
  const memoryCli = path.join(root, 'test/helpers/memory-fixture.js');
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify({ memory_writer: memoryCli, rotation_script: memoryCli }));
  function invoke(args, extra = {}) {
    for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(temporary + path.sep));
    const child = spawnSync(process.execPath, [path.join(root, 'scripts/reflect.js'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined);
    return { code: child.status, value: JSON.parse(child.stdout) };
  }
  const errors = path.join(temporary, 'errors.json');
  fs.writeFileSync(errors, JSON.stringify([
    { type: 'unchecked-conclusion', date: '2026-11-15', session_group: 'A', c4_id: 1, quote: 'Check the evidence.' },
    { type: 'unchecked-conclusion', date: '2026-11-16', session_group: 'B', c4_id: 2, quote: 'Check the evidence again.' }
  ]));
  assert.equal(invoke(['ledger', 'append', '--file', errors]).code, 0);
  const proposal = path.join(temporary, 'proposal.md');
  const typesFile = path.join(temporary, 'types.json');
  fs.writeFileSync(typesFile, '["unchecked-conclusion"]');
  function writeArgs(bytes, types = typesFile) {
    const replacement = original.replace('Old trait.', 'x'.repeat(bytes - Buffer.byteLength(original) + 'Old trait.'.length));
    assert.equal(Buffer.byteLength(replacement), bytes);
    fs.writeFileSync(proposal, replacement);
    return ['write-identity', '--file', proposal, '--sha256', crypto.createHash('sha256').update(original).digest('hex'), '--types', types];
  }
  return { invoke, writeArgs, env, memory, identity };
}

test('identity budget accepts 16384 bytes independently of references and rejects one extra byte', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.memory, 'references.md'), 'r'.repeat(16384));
  const original = fs.readFileSync(f.identity);
  const rejected = f.invoke(f.writeArgs(16385));
  assert.equal(rejected.code, 1);
  assert.match(rejected.value.error, /Identity exceeds its 16 KiB budget/);
  assert.equal(rejected.value.memory_bytes.identity_before, original.length);
  assert.equal(rejected.value.memory_bytes.identity_proposed, 16385);
  assert.equal(rejected.value.memory_bytes.identity_after, original.length);
  assert.equal(rejected.value.memory_bytes.combined_after, original.length + 16384);
  assert.ok(fs.readFileSync(f.identity).equals(original));
  assert.equal(fs.existsSync(f.env.FIXTURE_CALLS), false);
  const accepted = f.invoke(f.writeArgs(16384));
  assert.equal(accepted.code, 0);
  assert.equal(accepted.value.status, 'updated');
  assert.deepEqual(accepted.value.memory_bytes, { identity_before: original.length,
    identity_proposed: 16384, identity_after: 16384, references: 16384,
    combined_before: original.length + 16384, combined_after: 32768 });
  assert.equal(fs.statSync(f.identity).size, 16384);
});

test('busy identity writer reports unchanged actual bytes and the proposed size', t => {
  const f = fixture(t), original = fs.readFileSync(f.identity);
  const references = Buffer.from('\u4e2d'.repeat(100));
  fs.writeFileSync(path.join(f.memory, 'references.md'), references);
  const result = f.invoke(f.writeArgs(200), { FIXTURE_SYNC_BUSY: '1' });
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'write_deferred');
  assert.deepEqual(result.value.memory_bytes, { identity_before: original.length,
    identity_proposed: 200, identity_after: original.length, references: references.length,
    combined_before: original.length + references.length, combined_after: original.length + references.length });
  assert.ok(fs.readFileSync(f.identity).equals(original));
});

test('unavailable references size is reported without blocking an identity write', t => {
  const f = fixture(t);
  fs.symlinkSync('references.md', path.join(f.memory, 'references.md'));
  const result = f.invoke(f.writeArgs(200));
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'updated');
  assert.equal(result.value.memory_bytes.identity_after, 200);
  assert.equal(result.value.memory_bytes.references, null);
  assert.equal(result.value.memory_bytes.combined_before, null);
  assert.equal(result.value.memory_bytes.combined_after, null);
  assert.equal(result.value.memory_bytes.references_error, 'ELOOP');
});

test('rotation with only skipped targets stays pending and reports their reasons until enqueue succeeds', t => {
  const f = fixture(t);
  const result = f.invoke(f.writeArgs(200), { FIXTURE_ROTATION_EMPTY: '1' }).value;
  assert.equal(result.rotation.status, 'rotation_deferred');
  assert.equal(result.rotation.rotation.enqueued, 0);
  assert.equal(result.rotation.rotation.skipped.length, 2);
  assert.equal(result.rotation.rotation.skipped[0].session_group, 'telegram:room');
  assert.equal(result.rotation.rotation.skipped[0].reason, 'TARGET_NOT_RUNNING');
  const state = () => JSON.parse(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json')));
  assert.equal(state().rotation_pending, true);
  assert.equal(f.invoke(['rotation']).value.status, 'rotation_requested');
  assert.equal(state().rotation_pending, false);
});

test('identity accepts inline type arrays and rejects empty types', t => {
  const f = fixture(t);
  const invalid = f.invoke(f.writeArgs(200, '[]'));
  assert.equal(invalid.code, 1);
  assert.match(invalid.value.error, /requires error types/);
  const accepted = f.invoke(f.writeArgs(200, '["unchecked-conclusion"]'));
  assert.equal(accepted.value.status, 'updated');
  assert.equal(accepted.value.memory_bytes.references, 0);
  assert.equal(accepted.value.memory_bytes.combined_after, 200);
});
