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
const STATE_PATH = path.join(DATA_DIR, 'state.json');
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

function requireSqliteCli() {
  try {
    execFileSync('which', ['sqlite3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    console.error('sqlite3 CLI is required but not found. Install it with: apt-get install sqlite3');
    process.exit(1);
  }
}

function schedulerPrompt() {
  return 'Run the identity-reflection skill. Load and follow ~/zylos/.claude/skills/identity-reflection/SKILL.md. Use its required background-subagent execution model; the main session should only orchestrate and mark the scheduler task done after the subagent completes.';
}

function promptHash(prompt) {
  return crypto.createHash('sha256').update(prompt).digest('hex');
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function isManagedShortPrompt(task) {
  const prompt = task.prompt || '';
  return task.name === TASK_NAME && prompt.includes('Run the identity-reflection skill') && prompt.includes('identity-reflection/SKILL.md');
}

function addTask(prompt) {
  run('node', [SCHEDULER_CLI, 'add', prompt, '--cron', TASK_CRON, '--priority', '3', '--name', TASK_NAME]);
}

function pauseTask(taskId) {
  run('node', [SCHEDULER_CLI, 'pause', taskId]);
}

function ensureSchedulerTask(state) {
  const prompt = schedulerPrompt();
  const hash = promptHash(prompt);
  const tasks = schedulerTasks();

  for (const task of tasks) {
    if (isOldLongPrompt(task)) {
      console.log(`Pausing old long-prompt task: ${task.id}`);
      pauseTask(task.id);
    }
  }

  for (const task of tasks) {
    const staleCurrent = task.name === TASK_NAME && task.prompt === prompt && (task.status !== 'pending' || task.cron !== TASK_CRON);
    const staleManagedTemplate = isManagedShortPrompt(task) && task.prompt !== prompt;
    if (staleCurrent || staleManagedTemplate) {
      console.log(`Pausing stale managed scheduler task: ${task.id}`);
      pauseTask(task.id);
    }
  }

  const active = tasks.find(task => task.name === TASK_NAME && task.prompt === prompt && task.status === 'pending' && task.cron === TASK_CRON);
  if (!active && state.scheduler_prompt_hash !== hash) {
    console.log('Scheduler prompt template changed; registering updated task.');
    addTask(prompt);
  } else if (!active) {
    console.log('Expected scheduler task missing, paused, or wrong cron; registering fresh task.');
    addTask(prompt);
  } else {
    console.log(`Scheduler task is current: ${active.id}`);
  }

  state.scheduler_prompt_hash = hash;
}

console.log('[post-upgrade] Migrating identity-reflection config/state...');
requireSqliteCli();
const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
writeJson(CONFIG_PATH, config);

const state = { ...DEFAULT_STATE, ...readJson(STATE_PATH, DEFAULT_STATE), schema_version: 1 };
ensureSchedulerTask(state);
writeJson(STATE_PATH, state);

console.log('[post-upgrade] Complete!');
