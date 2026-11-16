import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/identity-reflection');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');
export const DEFAULT_CONFIG = {
  enabled: true,
  identity_file: path.join(ZYLOS_DIR, 'memory/identity.md'),
  c4_db_cli: path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-db.js'),
  c4_fetch_cli: path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-fetch.js'),
  thinking_patterns_data_dir: path.join(ZYLOS_DIR, 'components/thinking-patterns'),
  exclude_channels: ['internal', 'system', 'void', 'multica'],
  trace_max_clues: 15,
  trace_context: 8,
  trace_max_bytes: 262144,
  artifact_retention_days: 7,
  ledger_min_groups: 2,
  ledger_min_dates: 2,
  ledger_expiry_days: 60,
  memory_writer: path.join(ZYLOS_DIR, '.claude/skills/zylos-memory/scripts/memory-write.js'),
  rotation_script: path.join(ZYLOS_DIR, '.claude/skills/zylos-memory/scripts/request-rotation.js')
};
export function expandHome(value) { return typeof value === 'string' && value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value; }
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function normalizeState(old = {}) {
  if (old.schema_version === 2) return { ...old, groups: old.groups || {}, pending_clues: old.pending_clues || [] };
  return { schema_version: 2, groups: {}, pending_clues: [], last_run_at: null, last_result: null, last_identity_update_at: old.last_identity_update_at || null, scheduler_prompt_hash: old.scheduler_prompt_hash || null };
}
export function loadState() { return normalizeState(readJson(STATE_PATH, {})); }
export function loadConfig() {
  const old = readJson(path.join(DATA_DIR, 'config.json'), {});
  const result = { ...DEFAULT_CONFIG, ...old };
  if (old.c4_fetch_script && !old.c4_fetch_cli) result.c4_fetch_cli = old.c4_fetch_script;
  for (const key of ['c4_db', 'c4_fetch_script', 'min_conversations', 'max_conversations']) delete result[key];
  for (const key of ['identity_file', 'c4_db_cli', 'c4_fetch_cli', 'thinking_patterns_data_dir', 'memory_writer', 'rotation_script']) result[key] = expandHome(result[key]);
  for (const key of ['ledger_min_groups', 'ledger_min_dates', 'ledger_expiry_days']) if (!Number.isInteger(result[key]) || result[key] < 1) throw new Error(`Invalid ${key}`);
  return result;
}
