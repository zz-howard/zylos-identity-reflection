# Material and ledger contracts

Each run is saved under `components/identity-reflection/materials/<run_id>.json`.
The shared schema is the same as thinking-patterns: `schema_version: 1`,
`run_id`, `created_at`, `mode`, `ranges`, `session_files`, `reference_files`,
`inbound`, `filters`, `clues`, `traces`, `trace_complete`, `report` and
`trace_report`. A range is `{session_group,after,end,checkpoint_id}` with optional
time boundaries. Clues are `{session_group,c4_id,kind,source_range}`. Traces hold the clue,
same-thread rows and volume report. The collector lists changed memory paths;
the agent reads them only when needed. Core-projected text is never reprojected.

The reflection consumer reads thinking-patterns' `materials/` artifacts. It
reuses corrections and their traces only when range and channel filters match
exactly and trace processing completed. It collects all uncovered ranges itself.
Inbound collection rejects only stored content starting with `[Scheduled Task:` before wrapper extraction; the marker elsewhere is retained and trace context is unchanged. `filters.exclude_scheduled_tasks: true` records this contract. Older artifacts without that field fail filter matching and are recollected.
`report.reused_ranges` and zero inbound/session sizes prove successful reuse.
`report.reuse_misses` lists each uncovered thread with `range_mismatch`,
`filters_mismatch`, or `thinking_patterns_incomplete`.
Both components retain completed artifacts for seven days by default; incomplete
artifacts and state-held pending clues are retained for continuation.
Fetch resumes an active artifact until its ranges have all committed. Partial
commits expose `completed_groups`; committed or explicitly closed artifacts expire.
Deferred clues retain their original source range in state and artifact
`deferred_clues`, and do not prevent checkpoint advancement or new ranges on
the next fetch. Trace limits and reports accumulate across the entire run.
The first trace is accepted even when oversized. Sparse-thread expansion stops
within 2,000 C4 IDs of the clue and 1,000 before its original range, which may
return fewer context rows. A global content checkpoint identifies single-session
mode unless current Core configuration selects multi-session mode; rows keep
actual component groups, clues normalize to `*`, and logs use `memory/sessions/`.

## Wrapper Evidence

Inbound material and traced rows use one channel-independent rule: when a
complete `<current-message>...</current-message>` pair exists anywhere, keep
only its inner body, preceded by the first line if that line starts with `[`.
Without a complete pair, return the message unchanged. No channel names or
individual context tags are recognized. Body text stays as stored; context and
media outside the pair are omitted. Real Telegram group/DM and OpenMax OM-RUN
fixtures cover the observed format, with unchanged plain text and unknown
wrappers. There is no keyword or sender filter. Default excluded channels are
internal/system/void/multica.

## Ledger Evidence

Identity writes report `memory_bytes`: `identity_before`, `identity_proposed`,
`identity_after`, `references`, `combined_before` and `combined_after` in bytes.
Only proposed identity size above 16384 blocks writing; combined sizes never do.
Deferred/rejected writes retain the original actual after size. Missing
references counts as zero; an unavailable stat reports null combined values and
`references_error`, without blocking the writer.

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
