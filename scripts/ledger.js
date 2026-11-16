import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, ZYLOS_DIR, STATE_PATH, loadState, writeJson } from './settings.js';

const ledgerPath = path.join(DATA_DIR, 'ledger.jsonl');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const evidenceKey = row => hash(JSON.stringify([row.type, row.date, row.session_group, row.c4_id]));
function entries() {
  try { return fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function store(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${ledgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  fs.renameSync(temporary, ledgerPath);
}
function validError(row) {
  if (!row || typeof row.type !== 'string' || !row.type.trim() || row.type.length > 100 || /[\r\n]/.test(row.type)) throw new Error('Error type must be a short single line');
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) throw new Error('Error date must be a valid YYYY-MM-DD');
  if (typeof row.session_group !== 'string' || !row.session_group || /[\r\n]/.test(row.session_group)) throw new Error('Error requires session_group');
  if (!Number.isSafeInteger(row.c4_id) || row.c4_id < 1) throw new Error('Error requires a positive C4 id');
  if (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 500 || /[\r\n]/.test(row.quote)) throw new Error('Error quote must be one short line (up to 500 characters)');
  return { type: row.type.trim(), date: row.date, session_group: row.session_group, c4_id: row.c4_id, quote: row.quote.trim(), absorbed: false };
}
export function appendErrors(input, config) {
  if (!Array.isArray(input)) throw new Error('Errors must be a JSON array');
  const next = input.map(validError), rows = entries();
  const key = row => JSON.stringify([row.type, row.date, row.session_group, row.c4_id]);
  const seen = new Set(rows.map(key));
  let added = 0;
  for (const row of next) if (!seen.has(key(row))) { rows.push(row); seen.add(key(row)); added++; }
  store(rows);
  return { status: 'recorded', added, ...listErrors(undefined, config) };
}
export function listErrors(type, config) {
  const rows = entries().filter(row => !type || row.type === type);
  const thresholds = [...new Set(rows.map(row => row.type))].map(value => {
    const active = rows.filter(row => row.type === value && !row.absorbed);
    const groups = new Set(active.map(row => row.session_group)).size;
    const dates = new Set(active.map(row => row.date)).size;
    return { type: value, groups, dates, eligible: groups >= config.ledger_min_groups && dates >= config.ledger_min_dates };
  });
  return { entries: rows, thresholds };
}
export function cleanLedger(config, now = Date.now()) {
  const rows = entries(), latest = new Map();
  for (const row of rows) latest.set(row.type, Math.max(latest.get(row.type) || 0, Date.parse(`${row.date}T00:00:00Z`)));
  const kept = rows.filter(row => now - latest.get(row.type) <= config.ledger_expiry_days * 86400000);
  store(kept);
  return { status: 'cleaned', removed: rows.length - kept.length };
}
export function absorbErrors(type) {
  const state = loadState();
  if (!state.identity_receipt?.types.includes(type) || hash(fs.readFileSync(state.identity_receipt.file)) !== state.identity_receipt.sha256) throw new Error('Absorption requires a successful identity write receipt for this type');
  const rows = entries();
  let absorbed = 0;
  for (const row of rows) if (row.type === type && !row.absorbed && state.identity_receipt.evidence.includes(evidenceKey(row))) { row.absorbed = true; absorbed++; }
  store(rows);
  return { status: 'absorbed', type, absorbed };
}
function section(text) {
  const match = /^## Personality & Behavioral Traits[^\S\n]*\r?\n/m.exec(text);
  if (!match) throw new Error('Personality & Behavioral Traits section is missing; identity unchanged');
  const start = match.index + match[0].length;
  const next = /^## /m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return { prefix: text.slice(0, start), suffix: text.slice(end), body: text.slice(start, end) };
}
function child(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  return { ok: result.status === 0 && !result.error, exit_code: result.status, output: (result.stdout || '').trim(), error: result.error?.message || (result.stderr || '').trim() };
}
export function retryRotation(config) {
  const state = loadState();
  if (!state.rotation_pending) return { status: 'skip', reason: 'no_pending_rotation' };
  const rotation = fs.existsSync(config.rotation_script) ? child(config.rotation_script, ['--reason', 'identity']) : { ok: false, error: 'request-rotation.js is unavailable' };
  const count = /^OK: enqueued (\d+) rotation controls$/m.exec(rotation.output || '');
  rotation.enqueued = count ? Number(count[1]) : 0;
  rotation.skipped = [...(rotation.output || '').matchAll(/^SKIPPED: (\S+) (.+)$/gm)].map(([, session_group, reason]) => ({ session_group, reason }));
  rotation.ok = rotation.ok && rotation.enqueued > 0;
  if (!rotation.ok && !rotation.error) rotation.error = count ? 'No rotation controls were enqueued' : 'Rotation enqueue count is unavailable';
  state.rotation_pending = !rotation.ok;
  writeJson(STATE_PATH, state);
  return { status: rotation.ok ? 'rotation_requested' : 'rotation_deferred', rotation };
}
export function recoverIdentityWrite(config) {
  const state = loadState(), intent = state.identity_write_pending;
  if (!intent || intent.file !== config.identity_file || hash(fs.readFileSync(intent.file)) !== intent.sha256) return;
  state.identity_receipt = intent;
  state.last_identity_update_at = new Date().toISOString();
  state.rotation_pending = true;
  writeJson(STATE_PATH, state);
  for (const type of intent.types) absorbErrors(type, config);
  delete state.identity_write_pending;
  writeJson(STATE_PATH, state);
}
export function writeIdentity({ file, sha256, types }, config) {
  if (!Array.isArray(types) || !types.length || types.some(type => typeof type !== 'string')) throw new Error('Identity write requires error types');
  cleanLedger(config);
  const eligible = new Set(listErrors(undefined, config).thresholds.filter(item => item.eligible).map(item => item.type));
  if (types.some(type => !eligible.has(type))) throw new Error('Identity write requires the configured distinct-thread and distinct-date threshold for every type');
  const identity = fs.readFileSync(config.identity_file), replacement = fs.readFileSync(file);
  if (hash(identity) !== sha256) throw new Error('Identity hash changed; read and merge the current identity before retrying');
  const before = section(identity.toString('utf8')), after = section(replacement.toString('utf8'));
  if (before.prefix !== after.prefix || before.suffix !== after.suffix) throw new Error('Only Personality & Behavioral Traits may change');
  if (before.body === after.body) throw new Error('Identity proposal has no personality changes');
  if (replacement.length > 16384) throw new Error('Identity exceeds its 16 KiB budget; merge existing traits');
  // Save the expected result before the writer so a stopped run can reconcile it.
  const state = loadState();
  state.identity_write_pending = { file: config.identity_file, sha256: hash(replacement), types: [...new Set(types)], evidence: entries().filter(row => types.includes(row.type) && !row.absorbed).map(evidenceKey) };
  writeJson(STATE_PATH, state);
  let writer;
  if (fs.existsSync(config.memory_writer)) {
    const relative = path.relative(path.join(ZYLOS_DIR, 'memory'), config.identity_file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Identity file is outside memory root');
    writer = child(config.memory_writer, ['--path', relative, '--sha256', sha256], replacement);
    if (writer.ok) { try { if (JSON.parse(writer.output).ok !== true) writer.ok = false; } catch { writer.ok = false; } }
    if (!writer.ok) return { status: 'write_deferred', writer, ledger_preserved: true };
  } else {
    const temporary = `${config.identity_file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, replacement, { mode: fs.statSync(config.identity_file).mode });
    fs.renameSync(temporary, config.identity_file);
    writer = { ok: true, mode: 'legacy', warning: 'Core memory writer is unavailable; used legacy file replacement' };
  }
  recoverIdentityWrite(config);
  const rotation = retryRotation(config);
  return { status: 'updated', writer, rotation };
}
