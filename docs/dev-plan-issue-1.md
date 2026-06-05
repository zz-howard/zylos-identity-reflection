# Dev Plan: Implement Identity Reflection Component (#1)

## Summary

Build the zylos-identity-reflection utility component that periodically analyzes conversation history to detect stable behavioral trait changes and update the agent's identity file. Replaces the current long scheduler task description with a proper installable component featuring persistent state tracking, minimum conversation thresholds, and user-configurable conflict resolution policy.

## Scope

**In scope:**
- CLI script (`scripts/reflect.js`) that fetches unprocessed conversations, checks threshold, and outputs them for the skill to process
- Persistent state file (`state.json`) tracking last processed conversation ID range
- User-configurable policy file (`policy.md`) for identity conflict resolution priorities
- SKILL.md with the complete reflection workflow that the scheduler task dispatches
- Component lifecycle hooks (post-install creates data dir + default config + default policy)
- Run logging

**Out of scope:**
- Behavioral baseline / drift detection
- Multi-anchor identity architecture
- Automated trait updates without agent judgment (the skill instructs the agent what to analyze; the agent decides what to update)
- PM2 service (this is a CLI-invoked utility, not a long-running service)

## Design Decisions

1. **No PM2 service** — This component is invoked by the scheduler, not a long-running daemon. The scheduler task calls the skill, which runs `scripts/reflect.js` to fetch data, then the agent analyzes and updates identity.md.

2. **State tracking via `state.json`** — Stores `last_processed_id` (the end_id of the last successfully processed batch) and `last_run_at`. When a round is skipped due to insufficient conversations, `last_processed_id` stays unchanged — the next run picks up from where the last successful run left off.

3. **`scripts/reflect.js` responsibilities** — Single script that:
   - Reads `state.json` for the last processed ID
   - Queries C4 DB for conversations after that ID
   - Checks if count >= minimum threshold (from config)
   - If below threshold: outputs "SKIP" + count, exits 0
   - If at/above threshold: outputs the conversations in the same format as c4-fetch.js, exits 0
   - The script does NOT update state.json — the skill instructs the agent to update it after successful processing

4. **`policy.md` in data directory** — User-editable markdown file defining:
   - Participant priority (whose feedback weighs more when signals conflict)
   - What types of interactions count as identity-relevant
   - Any custom rules or constraints for identity evolution
   - Default: owner's direct feedback takes absolute priority; group interactions are secondary signals; identity changes require evidence from multiple conversations, not single events

5. **SKILL.md workflow** — The skill body describes the full reflection flow:
   1. Run `scripts/reflect.js` — if SKIP, mark scheduler task done and exit
   2. Read policy.md from data directory
   3. Read current identity.md
   4. Analyze conversations for stable behavioral patterns (not events, corrections, or temporary states)
   5. If stable trait changes detected, update only the Personality & Behavioral Traits section
   6. Update state.json with the new last_processed_id
   7. Log the run result

## Development Checklist

- [ ] **SKILL.md**: Write complete frontmatter (name, version, type, lifecycle, upgrade, config) and skill body with the reflection workflow
- [ ] **scripts/reflect.js**: Implement conversation fetching with state tracking and threshold check
- [ ] **hooks/post-install.js**: Create data directory, default config.json, default policy.md, empty state.json
- [ ] **hooks/post-upgrade.js**: Handle config schema migrations (add new fields with defaults)
- [ ] **config.json schema**: Define settings (min_conversations: 50, identity_file: "~/zylos/memory/identity.md")
- [ ] **Default policy.md**: Write sensible defaults for participant priority and trait classification rules
- [ ] **README.md**: Update with real component description, installation, configuration
- [ ] **CHANGELOG.md**: Add v0.1.0 entry
- [ ] **package.json**: Update with correct metadata, add better-sqlite3 dependency (for C4 DB access)
- [ ] **Remove unused template files**: ecosystem.config.cjs (no PM2 service), src/index.js, src/lib/config.js
- [ ] **Clean up**: Remove template placeholder content from all files

## Test Checklist

- [ ] `scripts/reflect.js` with no state.json → starts from conversation ID 0
- [ ] `scripts/reflect.js` with existing state.json → starts from last_processed_id
- [ ] `scripts/reflect.js` with fewer than min_conversations → outputs SKIP
- [ ] `scripts/reflect.js` with >= min_conversations → outputs conversations
- [ ] `hooks/post-install.js` creates all required files and directories
- [ ] Default policy.md is readable and makes sense
- [ ] Component installs cleanly via `zylos add identity-reflection`

## Acceptance Checklist

- [ ] SKILL.md frontmatter complete (name, version, type, lifecycle, upgrade)
- [ ] SKILL.md body contains full reflection workflow
- [ ] scripts/reflect.js correctly fetches conversations with state tracking
- [ ] Threshold logic works (skip when < 50 conversations)
- [ ] policy.md is user-editable and referenced by the skill
- [ ] state.json persists across runs and is not updated on skip
- [ ] post-install.js creates data dir, config, policy, state
- [ ] README.md documents installation and configuration
- [ ] No regressions — existing identity-reflection scheduler task can be replaced by this component
