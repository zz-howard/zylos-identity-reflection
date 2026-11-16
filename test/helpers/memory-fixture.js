import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
if (process.argv.includes('--reason')) {
  fs.appendFileSync(process.env.FIXTURE_CALLS, 'rotation\n');
  if (process.env.FIXTURE_ROTATION_REJECT === '1') { console.error('TRANSITION_OPEN'); process.exitCode = 1; }
  else if (process.env.FIXTURE_ROTATION_EMPTY === '1') { console.log('OK: enqueued 0 rotation controls\nSKIPPED: telegram:room TARGET_NOT_RUNNING\nSKIPPED: origin TRANSITION_OPEN'); }
  else console.log('OK: enqueued 1 rotation controls');
} else if (process.env.FIXTURE_SYNC_BUSY === '1') {
  console.log(JSON.stringify({ ok: false, error: { code: 'SYNC_BUSY' } }));
  process.exitCode = 2;
} else {
  const args = process.argv.slice(2);
  const file = path.join(process.env.ZYLOS_DIR, 'memory', args[args.indexOf('--path') + 1]);
  const expected = args[args.indexOf('--sha256') + 1];
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== expected) { console.log(JSON.stringify({ ok: false, error: { code: 'MEMORY_CONFLICT' } })); process.exitCode = 1; }
  else { fs.writeFileSync(file, fs.readFileSync(0)); console.log(JSON.stringify({ ok: true })); }
}
