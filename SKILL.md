---
name: identity-reflection
version: 0.4.0
description: Reflect nightly on new errors from checkpoint-covered memory and C4 context, reuse thinking-patterns correction evidence, and absorb repeated error types into stable personality traits.
type: utility

lifecycle:
  npm: true
  data_dir: ~/zylos/components/identity-reflection
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - policy.md
    - state.json
    - logs/
    - backups/
    - ledger.jsonl
    - materials/

upgrade:
  repo: zz-howard/zylos-identity-reflection
  branch: main

config:
  optional:
    - name: IDENTITY_REFLECTION_LEDGER_MIN_GROUPS
      description: Minimum distinct session groups before an error type can be absorbed. Stored in component config.json.
      default: "2"

dependencies:
  - comm-bridge
  - scheduler
---

# Identity Reflection

Use this skill when a scheduled `identity-reflection` task arrives, or when the owner explicitly asks to run identity reflection.

Identity reflection exists to help the owner and team get things done across sessions. It is not free-form self-improvement. It maintains accurate self-knowledge only where that self-knowledge improves future work.

## Core History Compatibility

History is accessed only through comm-bridge CLIs. If checkpoint or session-group
metadata is unavailable, fetch returns an explicit `unsupported_core` skip with
the reason and preserves progress. It never directly opens C4 SQLite. First
upgraded runs discard the global cursor and start from the most recent day.

## Execution Model

Reflection must run in a background subagent. The main session must not do the conversation analysis inline.

Outer layer, in the main session:
1. Launch a background subagent.
   - Claude runtime: use the Task tool with `run_in_background: true`.
   - Codex runtime: use the available background agent mechanism such as `spawn_agent`.
2. Give the subagent the Inner Subagent Workflow below.
3. Wait for the subagent result only when you are ready to mark the scheduled task done.
4. Run the scheduler `done` command from the scheduled task after the subagent completes.
5. If the subagent reports failure, investigate enough to avoid losing state; do not mark success silently.

## Inner Subagent Workflow

The subagent owns the actual reflection work:

1. Run:
   ```bash
   node ~/zylos/.claude/skills/identity-reflection/scripts/reflect.js fetch
   ```
2. Parse the JSON output. Fetch reconciles interrupted identity writes and cleans
   expired ledger types before computing eligibility, including quiet runs.
   Retry `rotation` when `rotation_pending` is true.
   Even with no new checkpoint material, review `pending_error_types` from the
   ledger and perform step 7 for eligible unabsorbed errors. Do not reread old
   transcripts. If `status` is `skip`, skip steps 3-6 and record this run with
   `commit --result skip` after handling these pending items; advance no ranges.
3. Read the component policy. For `reused` ranges, use only the supplied correction
   clues and traces. Do not reread their logs or inbound originals. A range with
   `reused_through` reused corrections up to that C4 id; its `inbound` holds only
   later messages, so select new clues only above that id. For uncovered
   ranges and those tails, read listed session logs, supplied `reference_changes` fragments (`changed_lines`
   marks new or edited lines; the others are context) and the
   entire `inbound` original-message net. Select correction clues by meaning,
   without keyword rules or sender identification.
   Read only the relevant original section if a fragment lacks necessary context;
   do not read whole reference files. `reference_baseline_note` reports the first
   baseline run, which deliberately supplies no reference content.
   Judge from context whether the corrected behavior was this Agent's own.
   Corrections of another Agent or person are excluded, including reused clues.
   Inbound collection excludes stored content starting with `[Scheduled Task:`; trace context is unchanged. Artifacts missing this filter are recollected.
4. Save uncovered clues as a JSON array of `{session_group,c4_id,kind:"correction"}`.
   Run `reflect.js trace --run <run_id> --clues <file>`, then read its traces.
   Include deferred reused correction clues already supplied by fetch; trace
   handles them automatically. Deferred decisions are irrelevant. Reused traces
   consume no local trace allowance. Local limits accumulate across this run
   and defer excess clues to state.
   Commit reviewed ranges after selection even when clues remain deferred. The
   next run processes those clues first while collecting new checkpoint ranges.
   Do not repeat trace calls to bypass limits. `completed_groups` must not be
   processed again within the active run.
   Even if no clues were found, call trace with `[]` to record completion.
5. Add only newly discovered errors using `reflect.js ledger append --file <file>`.
   Only corrections of this Agent's own actions qualify. Apply this contextual
   check to both reused and newly selected evidence; skip corrections of others.
   Each array entry contains `type,date,session_group,c4_id,quote`. Use one short
   quote, no event narrative. Group by error type, not similar-looking events.
6. `reflect.js ledger list --type <type>` compares the new error with the ledger.
   Default eligibility requires two distinct dates, in any threads.
   Also handle eligible `pending_error_types` retained from a deferred write.
   Never reread historical original conversations to establish repetition.
7. For an eligible type, read the current identity in full and hash its raw bytes.
   If the current traits already express the equivalent lesson, close the type
   without rewriting using `reflect.js ledger cover --types '["error-type"]'
   --sha256 <hash> --reason 'Identity already covers this behavior'`. This records
   the reason and current identity hash on absorbed evidence. Use this only for
   equivalent existing coverage; rewrite an existing trait when it is incomplete,
   misleading or contradicted by the repeated evidence.
   Prepare a complete replacement file, merging existing personality traits
   before adding content. Keep all other sections byte-identical and keep identity
   within its own 16 KiB (16384-byte) limit. Do not reject a write based on
   identity plus references; combined size is reporting only.
   Never write the live identity directly. Run:
   `reflect.js write-identity --file <replacement> --sha256 <hash> --types '["error-type"]'`.
   `--types` also accepts a path to a JSON array file.
   This uses Core's locked writer if present, absorbs only the successful write's
   evidence, and requests rotation. A busy Sync/hash conflict preserves unabsorbed
   errors for the next run. Report `write_deferred` and rotation rejection; run
   `reflect.js rotation` next time if rotation remains pending. Legacy Core writer
   absence is explicitly reported when direct replacement is used. Include
   `memory_bytes` in the run summary: identity before, proposed and actual after,
   references, and combined before/after, all in bytes. A rejected/deferred write
   reports unchanged actual after sizes. Missing references counts as zero;
   unavailable references size is null with `references_error`, never a write gate.
8. Run `reflect.js ledger clean` to remove types absent for 60 days. Commit only
   ranges actually reviewed using `reflect.js commit --run <run_id> --result
   no_change|updated --groups <comma-separated-completed-groups>`. A refused identity
   write can still commit reviewed material: the ledger retains the pending type.
9. Report fetch and trace counts, characters and bytes, reused ranges,
   `partially_reused_ranges`,
   `supplemental_traces`, `collected_ranges` and each `reuse_misses` reason, deferred
   clues, identity writer mode and rotation result. See `references/materials.md`.

## Identity Write Boundary

What belongs in `identity.md`:
- Stable character traits and behavioral patterns that have crystallized from repeated experience.
- Values and principles.
- Cognitive style and durable collaboration style.
- Capabilities that are stable enough to shape future work.

What does not belong in `identity.md`:
- Specific corrections or one-off lessons.
- Version numbers, project status, task state, or event logs.
- Operational details, config paths, database paths, or credentials.
- Anything that primarily describes what happened rather than who the agent is.

Only the `Personality & Behavioral Traits` section may be modified. `Who I Am`, `Principles`, `Communication Style`, `Digital Assets`, and every other section are read-only. If `Personality & Behavioral Traits` is missing, log a warning through the reflection commit/run log and do not modify the file.

## Reflection Standard

Ask:
- Has a repeated pattern of behavior solidified into a stable trait?
- Has an existing trait description become inaccurate?
- Is this durable self-knowledge, or just a recent event?

When in doubt, do not edit identity. Quality over frequency.
