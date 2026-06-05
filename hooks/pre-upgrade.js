#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(HOME, 'zylos');
const DATA_DIR = process.env.ZYLOS_DATA_DIR || path.join(ZYLOS_DIR, 'components/identity-reflection');
const BACKUP_DIR = path.join(DATA_DIR, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
const FILES = ['config.json', 'policy.md', 'state.json'];

console.log('[pre-upgrade] Backing up identity-reflection data...');

let copied = 0;
for (const name of FILES) {
  const source = path.join(DATA_DIR, name);
  if (!fs.existsSync(source)) continue;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(source, path.join(BACKUP_DIR, name));
  copied += 1;
  console.log(`Backed up ${name}`);
}

if (copied === 0) {
  console.log('No existing config/policy/state files to back up.');
} else {
  console.log(`Backup directory: ${BACKUP_DIR}`);
}

console.log('[pre-upgrade] Complete!');
