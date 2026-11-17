# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-17

### Actions After Upgrading
- None required.

### Changed
- When a thread received a new checkpoint after the thinking-patterns run, reuse that run's corrections and traces for the part it covered and collect only the newer messages, instead of rereading the whole thread. Fetch reports these threads in `partially_reused_ranges` and marks the range with `reused_through`; such a run still needs a trace call before commit.

## [0.3.0] - 2026-11-17

### Actions After Upgrading
- None required. A stored `ledger_min_groups` is removed from `config.json` automatically, and a leftover pending identity write record from 0.2.0 is cleared on the next fetch.

### Changed
- Ledger eligibility counts only distinct dates (default 2); the distinct-thread requirement is removed, so single-session instances can reach it. `ledger_min_groups` is dropped from config on load.

### Fixed
- Reuse a thinking-patterns thread only after its clue selection finished (`trace_report` present); otherwise collect it and report `clue_selection_unfinished`.
- Keep the identity write result and covered closures together for a run, and keep the outcome across partial commits until the final commit.
- Drop any pending identity intent whose replacement is not in place, including older intents.
- Reference fragments mark `changed_lines` and name the section above the first change, ignoring fenced code; user git config no longer affects the diff.
- Policy template allows closing an already-covered type with `ledger cover`.
- Reuse matching thread ranges regardless of producer trace completion, tracing only missing corrections under the reflection allowance.
- Deliver reference fragments against a baseline advanced only by successful complete material commits; omit full snapshots from CLI responses.
- Select only this Agent's own errors, close already-covered types with an identity hash and reason, and reconcile refused writes.
- Record explicit identity writer and rotation outcomes for every committed run.

## [0.2.0] - 2026-11-17

### Actions After Upgrading
- Installation and upgrade hooks remove stale component-managed tasks, including paused ones: the name must be `identity-reflection` and the prompt must contain both `Run the identity-reflection skill` and `identity-reflection/SKILL.md`. They create or retain one pending task with the current fixed prompt and nightly cron `30 0 * * *`. User-created tasks with different prompts and all thinking-patterns tasks are untouched. After upgrading, list scheduler tasks and confirm that exactly one pending component-managed identity-reflection task remains; preserve your custom tasks.

### Changed
- Exclude messages whose stored content starts with `[Scheduled Task:` from inbound material. Shared artifacts record this filter; artifacts without it are recollected rather than reused. Trace context is unchanged.
- Collect checkpoint-covered per-thread material through comm-bridge CLIs and reuse completed thinking-patterns correction evidence.
- Replace global backlog progress with per-thread state, beginning from the recent day on migration; explicitly skip unsupported Core history APIs.
- Schedule reflection nightly at 00:30 and remove stale component-managed scheduler tasks while preserving custom tasks.

### Added
- Compact error ledger with distinct-thread/date thresholds, absorption and stale-type expiry.
- Hash-checked personality-only identity writes using Core's locked memory writer when available, identity budget validation and rotation reporting.
- Bounded same-thread trace continuation, artifact retention and material volume reports.

## [0.1.5] - 2026-11-06

### Fixed
- `reflect.js fetch` no longer skips conversations when more than `max_conversations` are waiting: after the first run it takes the oldest ones after the cursor and sets `end_id` to the last of them, so a large backlog is caught up over several runs. The first run (cursor 0) still takes the newest ones (#11).

## [0.1.4] - 2026-11-06

### Fixed
- `reflect.js fetch` no longer fails with `ENOBUFS` when the transcript exceeds 1 MiB: subprocess output is now buffered up to 64 MiB (#8).
- `reflect.js` no longer truncates its JSON output when stdout is a pipe or socket: it ends by letting stdout drain instead of calling `process.exit()`. Before this, a large `fetch` envelope could be cut off with exit code 0.

### Changed
- `npm test` names its test files explicitly instead of relying on the default `node --test` scan.

## [0.1.3] - 2026-06-05

### Added
- CLAUDE.md with development guide and release process from zylos-component-template.

### Fixed
- Cap conversation fetch window to `max_conversations` (default 300) to prevent pulling entire DB on first run.
- Use SQL-based capping (`ORDER BY id DESC LIMIT N`) instead of ID arithmetic — handles non-contiguous IDs correctly.
- Bound cap query to `latestId` snapshot (`AND id <= endId`) to prevent read-snapshot race between queries.

### Changed
- Replace hardcoded "Howard" references with generic "owner" in SKILL.md, README.md, and default policy.md template.
- Remove legacy long-prompt task migration from post-install and post-upgrade hooks.

## [0.1.0] - 2026-06-05

### Added
- Initial identity-reflection utility component.
- `scripts/reflect.js fetch` with cursor-based C4 conversation fetching, threshold gating, and JSON envelope output.
- `scripts/reflect.js commit` with atomic state updates and run logging.
- Scheduler task registration and legacy long-prompt task migration in `post-install`.
- Background-subagent workflow and identity safety constraints in `SKILL.md`.
- User-editable policy file for identity-relevant signal priority.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add identity-reflection
```

No migration required.
