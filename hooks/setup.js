import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, ZYLOS_DIR, STATE_PATH, loadConfig, loadState, writeJson } from '../scripts/settings.js';

export const TASK_CRON = '30 0 * * *';
export const TASK_NAME = 'identity-reflection';
export const TASK_PROMPT = 'Run the identity-reflection skill. Load and follow ~/zylos/.claude/skills/identity-reflection/SKILL.md. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.';
const POLICY = `# Identity Reflection Policy

Reflect only on new errors identified in checkpoint-covered material. Reuse
thinking-patterns correction clues and traces when their thread ranges match;
read memory and inbound originals only for uncovered ranges. Select clues by
meaning, without sender identification or keyword filters.

Only corrections of this Agent's own behavior qualify, including reused clues.
Determine whose action was corrected from context, not sender identity. Skip
corrections of another Agent or person.
Record only error type, date, thread, C4 id and one short quote in the ledger.
Do not store event narratives. Compare new errors with the ledger by error type,
not by similarity of events. Default absorption requires at least two distinct
threads AND two distinct dates. Never turn a single correction into a trait.

Only edit Personality & Behavioral Traits. Merge and rewrite existing traits
before adding text; only a replacement identity above 16384 bytes exceeds the
size limit. Never gate on identity plus references. Report identity bytes before,
proposed and actual after writing, references bytes and combined before/after
bytes from memory_bytes in the run summary, including deferred/rejected writes.
Combined size is informational only. Use the
locked hash writer when available. A busy Sync or hash conflict defers writing;
keep ledger entries unabsorbed and retry from current content next time.
Mark a type absorbed after a successful identity write, then request identity
rotation and report a rejection. If the current identity already expresses the
lesson equivalently, close the type with \`ledger cover\` instead of rewriting.
Clean types absent for 60 days.
`;

export function setup() {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
  writeJson(path.join(DATA_DIR, 'config.json'), loadConfig());
  const policyPath = path.join(DATA_DIR, 'policy.md');
  if (!fs.existsSync(policyPath)) fs.writeFileSync(policyPath, POLICY);
  const state = loadState();
  const scheduler = path.join(ZYLOS_DIR, '.claude/skills/scheduler/scripts/cli.js');
  const run = args => execFileSync(process.execPath, [scheduler, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const tasks = JSON.parse(run(['list', '--json']));
  if (!Array.isArray(tasks)) throw new Error('Scheduler list must return task rows');
  const managed = tasks.filter(task => task.name === TASK_NAME && typeof task.prompt === 'string' && task.prompt.includes('Run the identity-reflection skill') && task.prompt.includes('identity-reflection/SKILL.md'));
  const current = managed.find(task => task.prompt === TASK_PROMPT && task.status === 'pending' && (task.cron_expression || task.cron) === TASK_CRON);
  for (const task of managed) if (task !== current) run(['remove', String(task.id)]);
  if (!current) run(['add', TASK_PROMPT, '--cron', TASK_CRON, '--priority', '3', '--name', TASK_NAME]);
  state.scheduler_prompt_hash = crypto.createHash('sha256').update(TASK_PROMPT).digest('hex');
  writeJson(STATE_PATH, state);
  console.log('[identity-reflection] Config/state migrated; nightly scheduler task is current.');
}
