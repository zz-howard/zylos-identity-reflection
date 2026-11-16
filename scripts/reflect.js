#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { collectMaterials, traceMaterials, commitMaterials, saveArtifact, readArtifacts, materialFailureReason } from './materials.js';
import { DATA_DIR, ZYLOS_DIR, loadConfig, loadState, writeJson, STATE_PATH } from './settings.js';
import { appendErrors, listErrors, cleanLedger, absorbErrors, writeIdentity, retryRotation, recoverIdentityWrite } from './ledger.js';

const MATERIAL_DIR = path.join(DATA_DIR, 'materials');

function argsOf(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) args._.push(argv[i]);
    else { const key = argv[i].slice(2); args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return args;
}
function inputFile(name) {
  if (typeof name !== 'string') throw new Error('A JSON input file is required');
  return JSON.parse(fs.readFileSync(name, 'utf8'));
}
function listInput(value) {
  if (typeof value !== 'string') throw new Error('A list is required');
  if (value.startsWith('[')) return JSON.parse(value);
  if (fs.existsSync(value)) return inputFile(value);
  return value.split(',').map(item => item.trim()).filter(Boolean);
}
function artifact(id) {
  const found = readArtifacts(MATERIAL_DIR).find(item => item.run_id === id);
  if (!found) throw new Error('Run artifact is unavailable; fetch first');
  return found;
}
function run() {
  const command = process.argv[2], args = argsOf(process.argv.slice(3));
  const config = loadConfig();
  if (command === 'fetch' && config.enabled) { recoverIdentityWrite(config); cleanLedger(config); }
  const state = loadState();
  if (command === 'fetch') {
    if (!config.enabled) return { status: 'skip', reason: 'disabled' };
    const pending = {
      pending_error_types: listErrors(undefined, config).thresholds.filter(item => item.eligible).map(item => item.type),
      rotation_pending: state.rotation_pending === true
    };
    let material;
    if (state.active_run) material = artifact(state.active_run);
    else {
      try { material = collectMaterials(config, state, { zylos_dir: ZYLOS_DIR, time_zone: config.time_zone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone, exclude_channels: config.exclude_channels, reuse_artifacts: readArtifacts(path.join(config.thinking_patterns_data_dir, 'materials')) }); }
      catch (error) { return { status: 'skip', mode: 'unsupported_core', reason: materialFailureReason(error), fallback_detail: error.message, groups_preserved: true, ...pending }; }
      material.clues = material.reused.flatMap(item => item.clues);
      material.traces = material.reused.flatMap(item => item.traces);
      material.trace_complete = material.ranges.length > 0 && material.reused.length === material.ranges.length && !state.pending_clues?.length;
      if (material.trace_complete) material.trace_report = { clues: material.traces.length, deferred: 0,
        bytes: material.traces.reduce((n, trace) => n + Buffer.byteLength(JSON.stringify(trace)), 0),
        characters: material.traces.reduce((n, trace) => n + (trace.report?.characters ?? 0), 0),
        count: material.traces.reduce((n, trace) => n + trace.rows.length, 0) };
      if (material.ranges.length || state.pending_clues?.length) {
        saveArtifact(MATERIAL_DIR, material, config.artifact_retention_days);
        writeJson(STATE_PATH, { ...state, active_run: material.run_id });
      }
    }
    return { status: material.ranges.length || state.pending_clues?.length ? 'ready' : 'skip', ...material, ...pending, completed_groups: state.completed_groups || [], identity_file: config.identity_file, policy_file: path.join(DATA_DIR, 'policy.md') };
  }
  if (command === 'trace') {
    const material = artifact(args.run || state.active_run);
    if (material.run_id !== state.active_run) throw new Error('Run is no longer active');
    const result = traceMaterials(config, state, material, inputFile(args.clues));
    saveArtifact(MATERIAL_DIR, result, config.artifact_retention_days);
    writeJson(STATE_PATH, state);
    return result;
  }
  if (command === 'commit') {
    if (!['skip', 'no_change', 'updated'].includes(args.result)) throw new Error('commit requires --result skip|no_change|updated');
    let next = state, material;
    if (args.result !== 'skip') {
      material = artifact(args.run || state.active_run);
      if (material.run_id !== state.active_run) throw new Error('Run is no longer active');
      const done = state.completed_groups || [];
      if (material.deferred_clues) state.pending_clues = material.deferred_clues;
      const groups = args.groups ? listInput(args.groups) : material.ranges.map(range => range.session_group).filter(group => !done.includes(group));
      next = commitMaterials(state, material, groups);
      next.completed_groups = [...new Set([...done, ...groups])];
      material.committed = material.ranges.every(range => (next.groups[range.session_group]?.end_conversation_id ?? 0) >= range.end);
      if (material.committed) { delete next.active_run; delete next.completed_groups; }
    } else if (state.active_run) {
      material = artifact(args.run || state.active_run);
      if (material.run_id !== state.active_run) throw new Error('Run is no longer active');
      if (material.deferred_clues) state.pending_clues = material.deferred_clues;
      delete next.active_run;
      delete next.completed_groups;
      material.closed = true;
    }
    next.last_run_at = new Date().toISOString();
    next.last_result = args.result;
    writeJson(STATE_PATH, next);
    if (material) saveArtifact(MATERIAL_DIR, material, config.artifact_retention_days);
    fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'logs/runs.jsonl'), JSON.stringify({ timestamp: next.last_run_at, result: args.result, report: material?.report || {}, trace_report: material?.trace_report || {}, pending_clues: next.pending_clues.length }) + '\n');
    return { status: 'committed', groups: next.groups, pending_clues: next.pending_clues.length };
  }
  if (command === 'ledger') {
    const action = args._[0];
    if (action === 'append') return appendErrors(inputFile(args.file), config);
    if (action === 'list') return listErrors(args.type, config);
    if (action === 'clean') return cleanLedger(config);
    if (action === 'absorb') return absorbErrors(args.type, config);
    throw new Error('Usage: reflect.js ledger append --file JSON | list [--type TYPE] | absorb --type TYPE | clean');
  }
  if (command === 'write-identity') return writeIdentity({ file: args.file, sha256: args.sha256, types: listInput(args.types) }, config);
  if (command === 'rotation') return retryRotation(config);
  throw new Error('Usage: reflect.js fetch | trace --clues FILE | commit --result RESULT | ledger ACTION | write-identity --file FILE --sha256 HASH --types FILE | rotation');
}
try { process.stdout.write(JSON.stringify(run(), null, 2) + '\n'); }
catch (error) { process.exitCode = 1; process.stdout.write(JSON.stringify({ status: 'error', error: error.message, ...(error.memory_bytes ? { memory_bytes: error.memory_bytes } : {}) }) + '\n'); }
