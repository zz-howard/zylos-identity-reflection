import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
// Identity size limits come from the real Core checkout, never a copy here.
assert.ok(process.env.ZYLOS_PACKAGE_ROOT, 'Set ZYLOS_PACKAGE_ROOT to a Core checkout with zylos-memory measureMemoryText');
const coreBudget = path.join(fs.realpathSync(process.env.ZYLOS_PACKAGE_ROOT), 'skills/zylos-memory/scripts/memory-budget.js');
const { measureMemoryText } = await import(pathToFileURL(coreBudget).href);
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
  fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify({ memory_writer: memoryCli, memory_budget: coreBudget, rotation_script: memoryCli }));
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
  const replacementOf = (chars, unit = 'x') => original.replace('Old trait.', unit.repeat(chars - original.length + 'Old trait.'.length));
  function writeArgs(chars, types = typesFile, unit = 'x') {
    const replacement = replacementOf(chars, unit);
    assert.equal(replacement.length, chars);
    fs.writeFileSync(proposal, replacement);
    return ['write-identity', '--file', proposal, '--sha256', crypto.createHash('sha256').update(original).digest('hex'), '--types', types];
  }
  return { invoke, writeArgs, replacementOf, env, memory, identity };
}

const size = text => { const m = measureMemoryText('identity.md', text); return { chars: m.chars, estimated_tokens: m.estimatedTokens, status: m.status }; };

test('Core decides the identity limit: the largest passing proposal is written and one more character is refused', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.identity, 'utf8');
  let largest = original.length;
  while (measureMemoryText('identity.md', f.replacementOf(largest + 1)).status !== 'over') largest++;
  // Negative control: the 16 KiB byte cap this replaces would have accepted the refused size.
  assert.ok(largest + 1 < 16384);
  const rejected = f.invoke(f.writeArgs(largest + 1));
  assert.equal(rejected.code, 1);
  assert.match(rejected.value.error, /exceeds the startup display limit/);
  assert.deepEqual(rejected.value.memory_size.identity_proposed, size(f.replacementOf(largest + 1)));
  assert.equal(rejected.value.memory_size.identity_proposed.status, 'over');
  assert.deepEqual(rejected.value.memory_size.identity_after, size(original));
  assert.equal(fs.readFileSync(f.identity, 'utf8'), original);
  assert.equal(fs.existsSync(f.env.FIXTURE_CALLS), false);
  const accepted = f.invoke(f.writeArgs(largest));
  assert.equal(accepted.code, 0);
  assert.equal(accepted.value.status, 'updated');
  const limits = measureMemoryText('identity.md', original);
  assert.deepEqual(accepted.value.memory_size, {
    limit: { chars: limits.maxChars, estimated_tokens: limits.maxTokens },
    warning_from: { chars: Math.ceil(limits.warnThreshold.chars), estimated_tokens: Math.ceil(limits.warnThreshold.estimatedTokens) },
    identity_before: size(original), identity_proposed: size(f.replacementOf(largest)), identity_after: size(f.replacementOf(largest)) });
  assert.equal(accepted.value.memory_size.identity_after.status, 'warning');
  assert.equal(fs.readFileSync(f.identity, 'utf8'), f.replacementOf(largest));
});

test('busy identity writer reports the unchanged actual size and the proposed size', t => {
  const f = fixture(t), original = fs.readFileSync(f.identity, 'utf8');
  const result = f.invoke(f.writeArgs(200), { FIXTURE_SYNC_BUSY: '1' });
  assert.equal(result.code, 0);
  assert.equal(result.value.status, 'write_deferred');
  assert.deepEqual(result.value.memory_size.identity_proposed, size(f.replacementOf(200)));
  assert.deepEqual(result.value.memory_size.identity_after, size(original));
  assert.equal(fs.readFileSync(f.identity, 'utf8'), original);
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
  assert.deepEqual(accepted.value.memory_size.identity_after, size(f.replacementOf(200)));
});
