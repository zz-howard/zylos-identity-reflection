# Material and ledger contracts

Each run is saved under `components/identity-reflection/materials/<run_id>.json`.
The shared schema is the same as thinking-patterns: `schema_version: 1`,
`run_id`, `created_at`, `mode`, `ranges`, `session_files`, `reference_files`,
`inbound`, `filters`, `clues`, `traces`, `trace_complete`, `report` and
`trace_report`. A range is `{session_group,after,end,checkpoint_id}` with optional
time boundaries. Clues are `{session_group,c4_id,kind}`. Traces hold the clue,
same-thread rows and volume report. The collector lists changed memory paths;
the agent reads them only when needed. Core-projected text is never reprojected.

The reflection consumer reads thinking-patterns' `materials/` artifacts. It
reuses corrections and their traces only when range and channel filters match
exactly and trace processing completed. It collects all uncovered ranges itself.
`report.reused_ranges` and zero inbound/session sizes prove successful reuse.
Both components retain completed artifacts for seven days by default; incomplete
artifacts and state-held pending clues are retained for continuation.
Fetch resumes an active artifact until its ranges have all committed. Partial
commits expose `completed_groups`; only fully committed artifacts are expired.

Core channel wrappers are stripped only through explicit delimiter tags
(`smart-mode`, `group-context`, `thread-context`, `replying-to`, and the
`current-message` boundary). Author signatures remain. There is no keyword or
sender filter. Default excluded channels are internal/system/void/multica.

`ledger.jsonl` stores `{type,date,session_group,c4_id,quote,absorbed}`. Dates use
the run's configured timezone. Quotes are single lines up to 500 characters.
Duplicates use type/date/thread/C4 id. Only unabsorbed entries contribute to the
distinct-thread and distinct-date thresholds. The latest occurrence of each type
controls its 60-day expiry, including absorbed history. No historical transcripts
or narratives are stored here. A successful writer receipt identifies precisely
the ledger evidence that may be absorbed; later errors cannot reuse that receipt.
Before writing identity, a pending receipt records the replacement hash and exact
evidence. Fetch reconciles it only if the identity's actual hash matches, completes
absorption and retains a rotation request. A saved intent alone absorbs nothing.
Expiry cleanup runs before eligibility checks and on quiet fetches too.
