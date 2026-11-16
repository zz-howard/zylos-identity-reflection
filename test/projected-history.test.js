import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { coreRoot } from './helpers/core-fixture.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const REFLECT = path.join(ROOT, 'scripts/reflect.js');
const CORE = coreRoot();
const CORE_SCRIPTS = path.join(CORE, 'skills/comm-bridge/scripts');
const { CONTENT_PREFIX } = await import(pathToFileURL(path.join(CORE_SCRIPTS, 'c4-content-schema.js')).href);
const protocol = JSON.parse(fs.readFileSync(path.join(CORE, 'test/fixtures/c4-content-protocol.json'), 'utf8'));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const hidden = 'HOST_PRIVATE_PAYLOAD_SENTINEL';

function fixture(t, core = CORE) {
  const scripts = path.join(core, 'skills/comm-bridge/scripts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-projection-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'instance'),
    ZYLOS_DATA_DIR: path.join(root, 'data'), PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux'), ZYLOS_PACKAGE_ROOT: core };
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const key of ['HOME', 'ZYLOS_DIR', 'ZYLOS_DATA_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep), key);
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(env.ZYLOS_DIR, '.zylos/config.json'), '{"runtime":"claude","session_mode":"multi"}');
  const db = path.join(env.ZYLOS_DIR, 'comm-bridge/c4.db');
  assert.ok(path.resolve(db).startsWith(root + path.sep));
  const config = { c4_db_cli: path.join(scripts, 'c4-db.js'),
    c4_fetch_cli: path.join(scripts, 'c4-fetch.js') };
  function configure(changes = {}) {
    Object.assign(config, changes);
    fs.writeFileSync(path.join(env.ZYLOS_DATA_DIR, 'config.json'), JSON.stringify(config));
  }
  configure();
  function invoke(script, args, override = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: ROOT, env: { ...env, ...override }, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  }
  const init = invoke(config.c4_db_cli, ['init']);
  assert.equal(init.status, 0, init.stderr);
  function sql(input) {
    return execFileSync('sqlite3', [db], { env, input, encoding: 'utf8', timeout: 5000 });
  }
  function seed(contents) {
    let id = 0;
    const rows = [];
    const grouped = sql('PRAGMA table_info(conversations);').includes('|session_group|');
    for (const direction of ['in', 'out']) for (const content of contents) {
      id += 1; rows.push({ id, direction, content });
      sql(`INSERT INTO conversations(id,timestamp,direction,channel,endpoint_id,content,status${grouped ? ',session_group' : ''})
        VALUES(${id},${quote(new Date().toISOString())},${quote(direction)},'dashboard','room',${quote(content)},'delivered'${grouped ? ",'dashboard:room'" : ''});`);
    }
    if (grouped) sql(`INSERT INTO group_heads(session_group,head_id) VALUES('dashboard:room',${id});
      INSERT INTO checkpoints(summary,start_conversation_id,end_conversation_id,session_group,no_content) VALUES('covered',1,${id},'dashboard:room',0);`);
    return rows;
  }
  return { root, env, config, configure, invoke, seed, sql };
}
function ready(f, script = REFLECT) {
  const child = f.invoke(script, ['fetch']);
  assert.equal(child.status, 0, child.stdout.slice(0, 500) + child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'ready');
  return { result, output: child.stdout };
}

// Integration: real component CLI -> actual Core fetch -> private SQLite
// -> projected inbound material consumed by the reflection agent. No model,
// services, runtime, PM2, tmux or network. Fixture validates owned paths before
// processes, bounds all children and registers cleanup before assertions.
// Run for history/readiness/prompt handoff changes; skip unrelated lifecycle/UI.
test('reflection original net contains projected inbound text and keeps source bodies intact', t => {
  const f = fixture(t);
  const envelope = structuredClone(protocol.valid.find(x => x.name === 'markdown').envelope);
  envelope.fallbackText = 'visible reflection summary'; envelope.blocks[0].data.text = hidden;
  const encode = x => CONTENT_PREFIX + JSON.stringify(x);
  const long = { ...envelope, messageId: 'long_history', blocks: [{ ...envelope.blocks[0], data: { text: hidden + 'x'.repeat(20000) } }] };
  const nested = { ...envelope, messageId: 'nested_history', fallbackText: CONTENT_PREFIX + 'literal fallback' };
  const answer = protocol.valid.find(x => x.name === 'answer_single_select').content;
  const plain = 'ordinary JSON {"ok":true}\nUnicode 中🚀 and \\ slash';
  const rows = f.seed([encode(envelope), CONTENT_PREFIX + '{"private":"' + hidden + '"', encode(long), plain, encode(nested), answer]);
  const before = f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;');
  const { result, output } = ready(f);
  assert.equal(result.inbound.length, rows.length / 2);
  assert.equal(output.includes(hidden), false);
  assert.equal(output.includes('"blocks"'), false);
  for (const row of rows.filter(row => row.direction === 'in')) {
    const content = result.inbound.find(item => item.id === row.id).content;
    if (row.content.includes('"private"')) assert.ok(content.includes(`[C4 content invalid; c4_id=${row.id}]`));
    else if (row.content === plain) assert.ok(content.includes(plain));
    else {
      const value = JSON.parse(row.content.slice(CONTENT_PREFIX.length));
      const interrupt = value.interruptId === undefined ? '' : ` interruptId=${value.interruptId}`;
      assert.ok(content.includes(`${value.fallbackText}\n[C4 messageId=${value.messageId}${interrupt}; c4_id=${row.id}]`));
      assert.equal(content.includes(row.content), false);
    }
  }
  assert.equal(f.sql('SELECT id,hex(content) FROM conversations ORDER BY id;'), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'))).groups['dashboard:room'], undefined);
});

// Integration: ordinary message content is preserved through the new material
// contract. Run for history formatting changes; skip unrelated hooks.
// Uses the same private paths, bounded subprocesses and cleanup as above.
test('ordinary reflection inbound payload preserves plain text', t => {
  const f = fixture(t);
  const contents = ['ordinary text', '{"ordinary":"JSON"}\n中文🚀', 'quotes \' and \\ and newlines\nend'];
  f.seed(contents);
  const { result } = ready(f);
  assert.equal(result.inbound.length, contents.length);
  for (let i = 0; i < contents.length; i++) assert.equal(result.inbound[i].content, contents[i]);
});

// Integration: older Core without checkpoint APIs cannot consume progress.
// Run for Core compatibility/history changes; skip unrelated hooks.
// Uses the same private DB/env and bounded children; no model or services.
test('a Core without checkpoint support skips explicitly without consuming progress', t => {
  const legacy = fs.realpathSync(process.env.TEST_LEGACY_CORE_ROOT);
  assert.equal(fs.existsSync(path.join(legacy, 'cli/lib/content-projection.js')), false);
  const f = fixture(t, legacy);
  f.seed(['ordinary legacy history', '{"ordinary":"JSON"}\n中文🚀', 'quotes \' and \\ slash']);
  const state = '{"last_processed_id":0,"last_observed_id":0}\n';
  fs.writeFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), state);
  f.env.ZYLOS_PACKAGE_ROOT = legacy;
  const child = f.invoke(REFLECT, ['fetch']);
  assert.equal(child.status, 0);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'skip');
  assert.equal(result.mode, 'unsupported_core');
  assert.ok(result.reason.length > 0);
  assert.equal(fs.readFileSync(path.join(f.env.ZYLOS_DATA_DIR, 'state.json'), 'utf8'), state);
});
