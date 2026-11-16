import fs from 'node:fs';
const [command, ...args] = process.argv.slice(2);
const statePath = process.env.FIXTURE_STATE;
const fixture = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(process.argv.slice(2)) + '\n');
const option = flag => args[args.indexOf(flag) + 1];
if (command === 'list') console.log(JSON.stringify(fixture.tasks || []));
else if (command === 'remove') {
  fixture.tasks = fixture.tasks.filter(task => task.id !== args[0]);
  fs.writeFileSync(statePath, JSON.stringify(fixture));
} else if (command === 'add') {
  fixture.tasks.push({ id: 'new-task', name: 'identity-reflection', prompt: args[0], status: 'pending', cron_expression: option('--cron') });
  fs.writeFileSync(statePath, JSON.stringify(fixture));
} else if (command === 'groups') console.log(JSON.stringify(fixture.groups || []));
else if (command === '--checkpoints') {
  if (fixture.unsupported) { console.error('Unknown option --checkpoints'); process.exitCode = 1; }
  else console.log(JSON.stringify((fixture.checkpoints || []).filter(row => row.session_group === (args.includes('--group') ? option('--group') : '*') && row.id > Number(option('--after')))));
} else {
  let rows = fixture.rows || [];
  if (command === '--since') rows = rows.filter(row => Date.parse(row.timestamp) >= Date.parse(args[0]));
  else if (command === '--begin') rows = rows.filter(row => row.id >= Number(args[0]) && row.id <= Number(option('--end')));
  console.log(JSON.stringify({ rows }));
}
