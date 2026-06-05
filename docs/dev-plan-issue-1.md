# Dev Plan: Implement Identity Reflection Component (#1)

## Summary

Build the zylos-identity-reflection utility component that periodically analyzes conversation history to detect stable behavioral trait changes and update the agent's identity file. Replaces the current long scheduler task description with a proper installable component featuring persistent state tracking, minimum conversation thresholds, and user-configurable conflict resolution policy.

## Scope

**In scope:**
- CLI script (`scripts/reflect.js`) that fetches unprocessed conversations, checks threshold, and outputs structured JSON for the skill to process
- `scripts/reflect.js commit` subcommand for atomic state updates after successful processing
- Persistent state file (`state.json`) tracking last processed conversation ID range and run history
- User-configurable policy file (`policy.md`) for identity conflict resolution priorities
- SKILL.md with the complete reflection workflow that the scheduler task dispatches
- Component lifecycle hooks (post-install creates data dir, default config, default policy, scheduler task registration)
- Scheduler task migration: post-install registers a new short-prompt scheduler task and detects/disables the old long-prompt task
- Run logging

**Out of scope:**
- Behavioral baseline / drift detection
- Multi-anchor identity architecture
- Automated trait updates without agent judgment (the skill instructs the agent what to analyze; the agent decides what to update)
- PM2 service (this is a CLI-invoked utility, not a long-running service)

## Design Decisions

1. **No PM2 service** — This component is invoked by the scheduler, not a long-running daemon. The scheduler dispatches the skill, which orchestrates a background subagent to do the actual work.

2. **Cursor-based data model** — Chosen per Howard's latest instruction (2026-06-05): track unprocessed conversations via a cursor (`last_processed_id`), with minimum threshold gating. This differs from the earlier 24h sliding window approach; `lookback_hours` is intentionally out of v0.1 scope unless Howard's policy changes.

3. **State tracking via `state.json`** — Stores:
   - `last_processed_id`: end_id of the last successfully processed batch (only advanced on `no_change` or `updated`, never on `skip`)
   - `last_observed_id`: end_id of the most recent fetch, including skips (for diagnostics)
   - `last_run_at`: timestamp of last execution (including skips)
   - `last_result`: "skip" | "no_change" | "updated"
   - `last_identity_update_at`: timestamp of last actual identity.md change

4. **`scripts/reflect.js` design** — Two subcommands with structured JSON output:

   `scripts/reflect.js fetch`:
   - Reads `state.json` for `last_processed_id` (defaults to 0 if missing)
   - Queries latest conversation ID via `sqlite3` CLI on c4.db
   - Calls existing `c4-fetch.js --begin <last_id+1> --end <latest_id>` (compose existing capability, no native sqlite dependency)
   - Checks if count >= `min_conversations` from config
   - Outputs JSON envelope: `{ "status": "skip"|"ready", "begin_id": N, "end_id": N, "count": N, "conversations": "..." }`
   - When status is "ready", `conversations` contains the full transcript text

   `scripts/reflect.js commit --result skip [--observed-end-id <N>]`:
   - Updates `last_run_at`, `last_result`, `last_observed_id`
   - Does NOT advance `last_processed_id`

   `scripts/reflect.js commit --result <no_change|updated> --end-id <N>`:
   - Advances `last_processed_id` to `<N>`
   - Updates `last_run_at`, `last_result`, `last_observed_id`
   - If result is "updated", also sets `last_identity_update_at`
   - Appends entry to run log

   All state writes use atomic write (temp file + rename).

5. **Compose existing C4 scripts** — Instead of adding `better-sqlite3` as a native dependency, the reflect script shells out to `c4-fetch.js` (which already has sqlite access) and uses `sqlite3` CLI for the latest-id query. This avoids Node ABI rebuild risk and follows "compose existing capability."

6. **`policy.md` in data directory** — User-editable markdown file defining:
   - Participant priority (whose feedback weighs more when signals conflict)
   - What types of interactions count as identity-relevant
   - Any custom rules or constraints for identity evolution
   - Default: owner's direct feedback takes absolute priority; group interactions are secondary signals; identity changes require evidence from multiple conversations, not single events

7. **Scheduler task registration** — `hooks/post-install.js` registers the scheduler task using a two-step mechanism:
   - **Detection**: Query `~/zylos/scheduler/scheduler.db` via `sqlite3` CLI to find existing tasks. Schema dependency: `tasks` table with columns `id`, `prompt`, `status`. This is documented as an explicit dependency on the scheduler's DB schema.
   - **Old task migration**: Match old long-prompt tasks by fingerprint (prompt contains both "identity-reflection" AND "MOTIVATION" or "WHAT BELONGS" — the distinctive markers of the old inline prompt). Pause matched tasks via `cli.js pause <task-id>`.
   - **New task creation**: If no task with the new short prompt exists, create via `cli.js add` with cron `0 0,12 * * *` and a short prompt that invokes the identity-reflection skill.
   - **Idempotency**: Detection query runs first; if correct task already exists, skip creation.
   - Post-upgrade re-registers if the prompt template hash changes.

8. **Background subagent execution** — SKILL.md workflow specifies a two-layer execution model:
   - **Outer layer (main session)**: Receives scheduled task, launches a background subagent (Claude: Task tool with `run_in_background: true`; Codex: equivalent background mechanism), marks scheduler task done after subagent completes.
   - **Inner layer (background subagent)**: Executes the full reflection flow:
     1. Run `scripts/reflect.js fetch` — parse JSON output
     2. If status is "skip": run `scripts/reflect.js commit --result skip --observed-end-id <end_id>`, exit
     3. Read `policy.md` from data directory
     4. Read current `identity.md`
     5. Analyze conversations for stable behavioral patterns (not events, corrections, or temporary states)
     6. If stable trait changes detected, update only the Personality & Behavioral Traits section of identity.md
     7. Run `scripts/reflect.js commit --result <no_change|updated> --end-id <end_id>`

   This ensures reflection work does not block the main session or heartbeat delivery.

9. **Identity safety** — SKILL.md explicitly constrains: only the Personality & Behavioral Traits section may be modified. Who I Am, Principles, Digital Assets, and other sections are read-only. If the section doesn't exist, log a warning and skip.

## Development Checklist

- [ ] **SKILL.md**: Write complete frontmatter (name, version, type, lifecycle, upgrade, config) and skill body with the reflection workflow
- [ ] **scripts/reflect.js**: Implement `fetch` subcommand (state read, c4-fetch composition, threshold check, JSON envelope output)
- [ ] **scripts/reflect.js**: Implement `commit` subcommand (atomic state.json update, run log append)
- [ ] **hooks/post-install.js**: Create data directory, default config.json, default policy.md, empty state.json; register scheduler task via sqlite3 detection + cli.js add; detect/pause old long-prompt task by fingerprint
- [ ] **hooks/post-upgrade.js**: Handle config schema migrations, re-register scheduler task if prompt changed
- [ ] **hooks/pre-upgrade.js**: Backup state.json and policy.md
- [ ] **config.json schema**: Define settings (min_conversations: 50, identity_file: "~/zylos/memory/identity.md")
- [ ] **Default policy.md**: Write sensible defaults for participant priority and trait classification rules
- [ ] **README.md**: Update with real component description, installation, configuration
- [ ] **CHANGELOG.md**: Add v0.1.0 entry
- [ ] **package.json**: Update with correct metadata (no native sqlite dependency)
- [ ] **Remove unused template files**: ecosystem.config.cjs (no PM2 service), src/index.js, src/lib/config.js
- [ ] **Clean up**: Remove template placeholder content from all files

## Test Checklist

### reflect.js fetch
- [ ] No state.json → starts from conversation ID 0, outputs JSON with status
- [ ] Existing state.json → starts from last_processed_id + 1
- [ ] Fewer than min_conversations → JSON `{ "status": "skip", "count": N }`
- [ ] At/above min_conversations → JSON `{ "status": "ready", "count": N, "conversations": "..." }`
- [ ] Missing C4 DB → graceful error (exit 1, JSON error message)
- [ ] Empty C4 window (no conversations at all) → status "skip", count 0

### reflect.js commit
- [ ] Updates state.json atomically (write to temp then rename)
- [ ] `commit --result skip --observed-end-id <N>` → last_processed_id unchanged, last_observed_id set, last_run_at updated
- [ ] `commit --result skip` (no --observed-end-id) → still works, last_observed_id stays
- [ ] `commit --result no_change --end-id <N>` → last_processed_id advanced to N, last_run_at updated
- [ ] `commit --result updated --end-id <N>` → last_processed_id advanced, last_identity_update_at set
- [ ] `commit --result no_change|updated` without --end-id → error (required for non-skip)
- [ ] Appends to run log
- [ ] Missing state.json → creates it

### Scheduler task lifecycle
- [ ] Fresh install → scheduler task "identity-reflection" exists with correct short prompt and cron
- [ ] Reinstall/upgrade → no duplicate task created (idempotent detection via scheduler.db query)
- [ ] Existing old long-prompt task → detected by fingerprint (prompt contains "identity-reflection" + "MOTIVATION" or "WHAT BELONGS"), paused
- [ ] User-created task with name "identity-reflection" but different prompt → not touched (fingerprint mismatch)
- [ ] post-upgrade with changed prompt template → task re-registered

### Background subagent execution
- [ ] SKILL.md workflow explicitly requires background subagent (Claude: Task run_in_background; Codex: equivalent)
- [ ] Main session only orchestrates: launch subagent → wait → mark scheduler done
- [ ] Reflection analysis runs entirely in subagent context, not inline

### Config robustness
- [ ] Missing config.json → uses defaults
- [ ] Malformed config.json → graceful error
- [ ] Missing/malformed state.json → reinitializes
- [ ] Invalid identity_file path → logs warning, skips update

### Identity safety
- [ ] Only Personality & Behavioral Traits section modified
- [ ] Missing section → warning logged, no modification
- [ ] Who I Am / Principles / Digital Assets untouched

### Component lifecycle
- [ ] post-install creates data dir, config, policy, state, scheduler task
- [ ] post-upgrade preserves user-edited policy.md, state.json, logs
- [ ] pre-upgrade backs up state.json and policy.md
- [ ] `zylos add identity-reflection` completes in fresh environment

## Acceptance Checklist

- [ ] SKILL.md frontmatter complete (name, version, type, lifecycle, upgrade)
- [ ] SKILL.md body contains full reflection workflow with identity safety constraints and background subagent requirement
- [ ] `scripts/reflect.js fetch` outputs stable JSON contract
- [ ] `scripts/reflect.js commit` updates state atomically
- [ ] Threshold logic works (skip when < 50 conversations)
- [ ] policy.md is user-editable and referenced by the skill
- [ ] state.json persists across runs; not advanced on skip
- [ ] post-install registers scheduler task and detects old task
- [ ] README.md documents installation, configuration, and policy customization
- [ ] End-to-end flow: `zylos add` → scheduler dispatches → reflect fetch → agent analyzes → reflect commit → scheduler done
- [ ] Upgrade/reinstall does not duplicate scheduler tasks or lose user data
