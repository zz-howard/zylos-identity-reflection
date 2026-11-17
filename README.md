<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-identity-reflection</h1>

Nightly reflection on repeated errors, using checkpoint-covered memory and C4
context. Requires Node.js 20+ and comm-bridge/scheduler CLIs. No C4 database is
opened by the component.

## Flow

The background agent reads memory and channel-filtered inbound originals, selects
correction clues, and fetches bounded same-thread context. Completed, matching
thinking-patterns material is reused before reading logs or originals; when a
thread gained a checkpoint after that run, only the newer messages are collected.
Inbound collection excludes stored content starting with `[Scheduled Task:`; the marker elsewhere is retained and trace context is unchanged. Artifacts missing this filter are recollected.
Only errors are recorded in the compact ledger. An error type must appear on at
least two distinct dates (in any threads) before it may change
`Personality & Behavioral Traits`; all other identity sections remain unchanged.

Installation and upgrade register one nightly `30 0 * * *` task. Stale managed
tasks are removed through scheduler CLI. Custom same-name tasks with different
prompts are preserved. Thinking-patterns tasks are untouched. No manual legacy
task fingerprints are recognized.

## Configuration

Data lives in `~/zylos/components/identity-reflection`. Defaults include:

```json
{
  "enabled": true,
  "exclude_channels": ["internal", "system", "void", "multica"],
  "trace_max_clues": 15,
  "trace_context": 8,
  "trace_max_bytes": 262144,
  "artifact_retention_days": 7,
  "ledger_min_dates": 2,
  "ledger_expiry_days": 60
}
```

`identity_file`, `c4_db_cli`, `c4_fetch_cli`, `memory_writer`, `rotation_script`
and `thinking_patterns_data_dir` default to the corresponding Zylos paths. Existing
policy prose is preserved. The updated SKILL workflow and CLI enforce error
thresholds, section boundaries and identity's own 16 KiB budget (references is separate).

State schema 2 uses `groups[group].end_conversation_id` and `checkpoint_id`.
Upgrading discards the old global cursor and old backlog, starting within the
recent day. Checkpoint failure or missing group metadata produces an explicit
skip, preserving all progress. There is no sender identification.

## Commands

See [SKILL.md](SKILL.md) for the complete background-agent workflow. Commands:

```sh
node scripts/reflect.js fetch
node scripts/reflect.js trace --run RUN --clues clues.json
node scripts/reflect.js ledger append --file errors.json
node scripts/reflect.js ledger list --type premature-conclusion
node scripts/reflect.js ledger clean
node scripts/reflect.js ledger cover --types '["premature-conclusion"]' --sha256 HASH --reason 'Identity already covers this behavior'
node scripts/reflect.js write-identity --file proposal.md --sha256 HASH --types types.json
node scripts/reflect.js rotation
node scripts/reflect.js commit --run RUN --result no_change --groups groups.json
```

Ledger entries contain only type, date, thread, C4 id, one short quote and
absorption state. `ledger absorb --type TYPE` requires a successful identity-write
receipt and applies only to evidence present at that write. `ledger cover` closes
eligible types the current identity already expresses, recording the reason and
identity hash without writing. Writer refusal leaves
the ledger intact; rotation refusal remains pending for retry. Old Core without
the writer uses an explicitly reported legacy replacement.

Artifacts and volume reports are documented in [references/materials.md](references/materials.md).

## Tests

`npm test` runs explicit `.test.js` files with temporary HOME, ZYLOS_DIR,
ZYLOS_DATA_DIR, PM2_HOME and TMPDIR, private CLI fixtures, bounded child-process
timeouts and no live service/database access. `npm run check` checks syntax.
Real-Core integration requires an existing current Core checkout with its protocol
fixture and dependencies, an older Core checkout without checkpoint/group APIs,
and `sqlite3`. The tests initialize matching private database schemas; never point
them at a live instance. They isolate HOME, ZYLOS_DIR, ZYLOS_DATA_DIR, PM2_HOME,
short TMPDIR and TMUX_TMPDIR, check target paths before starting children, apply
timeouts and remove owned resources. No runtime, tmux server or network starts.

```sh
ZYLOS_PACKAGE_ROOT=/path/to/current-core \
TEST_LEGACY_CORE_ROOT=/path/to/older-core npm run test:integration
```

`projected-history.test.js` covers checkpoint projection and unsupported Core;
`locked-writer.test.js` covers the actual Core memory lock, rejection and successful
absorption; `material-reuse.test.js` covers producer/consumer artifact reuse with
real checkpoint CLIs. Each file documents when its boundary needs retesting.
Real DGX one-day volumes remain a reviewer-run acceptance check.

## License

[MIT](LICENSE)
