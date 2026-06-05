#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(HOME, 'zylos');
const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/identity-reflection');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const POLICY_PATH = path.join(DATA_DIR, 'policy.md');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const SCHEDULER_DB = path.join(ZYLOS_DIR, 'scheduler/scheduler.db');
const SCHEDULER_CLI = path.join(ZYLOS_DIR, '.claude/skills/scheduler/scripts/cli.js');
const TASK_NAME = 'identity-reflection';
const TASK_CRON = '0 0,12 * * *';

const DEFAULT_CONFIG = {
  enabled: true,
  min_conversations: 50,
  identity_file: '~/zylos/memory/identity.md',
  c4_db: '~/zylos/comm-bridge/c4.db',
  c4_fetch_script: '~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js'
};

const DEFAULT_STATE = {
  schema_version: 1,
  last_processed_id: 0,
  last_observed_id: 0,
  last_run_at: null,
  last_result: null,
  last_identity_update_at: null,
  scheduler_prompt_hash: null
};

const DEFAULT_POLICY = `# Identity Reflection Policy

## Purpose

Identity reflection exists to preserve useful self-knowledge so the agent can keep helping Howard and the team get things done across sessions.

## Identity-Relevant Signals

- Stable character traits and repeated behavioral patterns.
- Repeated feedback about collaboration style, judgment, or communication.
- Durable capability changes that affect how the agent should understand its work.

## What Does Not Belong in Identity

- One-off corrections or individual events.
- Project status, version numbers, task lists, or operational logs.
- Config paths, credentials, or implementation details.

## Priority

1. Howard's direct feedback has absolute priority.
2. Repeated patterns from day-to-day work are secondary signals.
3. Group interactions are useful only when they reinforce a repeated pattern.

Identity changes require evidence from multiple interactions or a clear durable instruction from Howard. When in doubt, do not edit identity.md.
`;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  return true;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { ...fallback };
    throw err;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function schedulerPrompt() {
  return 'Run the identity-reflection skill. Load and follow ~/zylos/.claude/skills/identity-reflection/SKILL.md. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.';
}

function promptHash(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function schedulerTasks() {
  if (!fs.existsSync(SCHEDULER_DB)) return [];
  const sql = "SELECT id, name, prompt, status, COALESCE(cron_expression, '') AS cron FROM tasks WHERE name = 'identity-reflection' OR prompt LIKE '%identity-reflection%' ORDER BY id;";
  const output = run('sqlite3', ['-json', SCHEDULER_DB, sql]).trim();
  return output ? JSON.parse(output) : [];
}

function isOldLongPrompt(task) {
  const prompt = task.prompt || '';
  return prompt.includes('identity-reflection') && (prompt.includes('MOTIVATION') || prompt.includes('WHAT BELONGS'));
}

function isCurrentTask(task, expectedPrompt) {
  return task.name === TASK_NAME && task.prompt === expectedPrompt;
}

function isManagedShortPrompt(task) {
  const prompt = task.prompt || '';
  return task.name === TASK_NAME && prompt.includes('Run the identity-reflection skill') && prompt.includes('identity-reflection/SKILL.md');
}

function pauseTask(taskId) {
  run('node', [SCHEDULER_CLI, 'pause', taskId]);
}

function addTask(expectedPrompt) {
  run('node', [SCHEDULER_CLI, 'add', expectedPrompt, '--cron', TASK_CRON, '--priority', '3', '--name', TASK_NAME]);
}

function ensureSchedulerTask() {
  const expectedPrompt = schedulerPrompt();
  const expectedHash = promptHash(expectedPrompt);
  const state = readJson(STATE_PATH, DEFAULT_STATE);
  const tasks = schedulerTasks();

  for (const task of tasks) {
    if (isOldLongPrompt(task)) {
      console.log(`Pausing old long-prompt task: ${task.id}`);
      pauseTask(task.id);
    }
  }

  const currentTasks = tasks.filter(task => isCurrentTask(task, expectedPrompt));
  const activeCurrent = currentTasks.find(task => task.status === 'pending' && task.cron === TASK_CRON);

  for (const task of tasks) {
    const staleCurrent = isCurrentTask(task, expectedPrompt) && (task.status !== 'pending' || task.cron !== TASK_CRON);
    const staleManagedTemplate = isManagedShortPrompt(task) && task.prompt !== expectedPrompt;
    if (staleCurrent || staleManagedTemplate) {
      console.log(`Pausing stale managed scheduler task: ${task.id}`);
      pauseTask(task.id);
    }
  }

  if (activeCurrent) {
    console.log(`Scheduler task already registered: ${activeCurrent.id}`);
  } else {
    const staleCurrent = currentTasks.map(task => `${task.id} status=${task.status} cron=${task.cron || '(none)'}`).join(', ');
    if (staleCurrent) console.log(`Existing current-prompt task is not active with expected cron (${staleCurrent}); creating a fresh active task.`);
    console.log('Creating scheduler task identity-reflection...');
    addTask(expectedPrompt);
  }

  state.scheduler_prompt_hash = expectedHash;
  writeJson(STATE_PATH, { ...DEFAULT_STATE, ...state, schema_version: 1 });
}

console.log('[post-install] Setting up identity-reflection...');
ensureDir(DATA_DIR);
ensureDir(LOG_DIR);

if (writeIfMissing(CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)) {
  console.log('Created config.json');
} else {
  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
  writeJson(CONFIG_PATH, config);
  console.log('Config exists; ensured default fields');
}

if (writeIfMissing(POLICY_PATH, DEFAULT_POLICY)) {
  console.log('Created policy.md');
} else {
  console.log('Policy exists; preserving user edits');
}

if (writeIfMissing(STATE_PATH, `${JSON.stringify(DEFAULT_STATE, null, 2)}\n`)) {
  console.log('Created state.json');
} else {
  const state = { ...DEFAULT_STATE, ...readJson(STATE_PATH, DEFAULT_STATE), schema_version: 1 };
  writeJson(STATE_PATH, state);
  console.log('State exists; ensured default fields');
}

ensureSchedulerTask();
console.log('[post-install] Complete!');
