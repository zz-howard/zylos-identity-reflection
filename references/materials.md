# Material and ledger contracts

Each run is saved under `components/identity-reflection/materials/<run_id>.json`.
The shared schema is the same as thinking-patterns: `schema_version: 1`,
`run_id`, `created_at`, `mode`, `ranges`, `session_files`, `reference_files`,
`inbound`, `filters`, `clues`, `traces`, `trace_complete`, `report` and
`trace_report`. A range is `{session_group,after,end,checkpoint_id}` with optional
time boundaries. Clues are `{session_group,c4_id,kind,source_range}`. Traces hold the clue,
same-thread rows and volume report. `reference_changes` supplies current changed
text with nearby context; `changed_lines` marks new or edited lines and `section`
is the nearest heading above the first change outside fenced code. Read only a relevant original section if needed.
The private artifact's `reference_snapshot` is omitted from CLI output. A
component-local `reference_baseline` advances atomically with a fully successful
material commit; partial, skipped and failed runs retain the prior baseline.
The first baseline run supplies no reference text and reports
`reference_baseline_note`. New files emit full content; unchanged and removed
files emit nothing. `report.references` measures emitted fragments.
Core-projected text is never reprojected.

The reflection consumer reads thinking-patterns' `materials/` artifacts. It
reuses corrections and their traces only when range and channel filters match
exactly and the producer finished clue selection (its artifact has `trace_report`,
which trace records even for an empty clue list), regardless of the producer's
overall trace completeness. Deferred
correction clues are traced locally under a separate cumulative allowance;
deferred decisions are ignored. It collects only uncovered ranges itself.
Inbound collection rejects only stored content starting with `[Scheduled Task:` before wrapper extraction; the marker elsewhere is retained and trace context is unchanged. `filters.exclude_scheduled_tasks: true` records this contract. Older artifacts without that field fail filter matching and are recollected.
`report.reused_ranges` and zero inbound/session sizes prove successful reuse.
`report.reuse_misses` lists each uncovered thread with `range_mismatch`,
`filters_mismatch`, or `clue_selection_unfinished` (matching producer runs had
not selected clues yet). `collected_ranges` counts fully collected threads and
`supplemental_traces` counts locally traced reused correction clues.
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
distinct-date threshold (threads are not counted). The latest occurrence of each type
controls its 60-day expiry, including absorbed history. No historical transcripts
or narratives are stored here. A successful writer receipt identifies precisely
the ledger evidence that may be absorbed; later errors cannot reuse that receipt.
Before writing identity, a pending receipt records the replacement hash and exact
evidence. Fetch reconciles it only if the identity's actual hash matches, completes
absorption and retains a rotation request. A saved intent alone absorbs nothing.
Expiry cleanup runs before eligibility checks and on quiet fetches too.

`ledger cover` closes eligible evidence already expressed equivalently in the
current identity, recording `absorption_reason` and `identity_sha256` without
writing identity or requesting rotation. Contextual attribution to this Agent
is required before adding any error, regardless of its source.
A pending intent whose replacement is not in place (never applied or replaced
since) is dropped on fetch or writer rejection; its evidence stays unabsorbed for
review. An already-applied replacement is recovered and absorbed before rotation
is requested.
Each run log includes `identity_write` with explicit status, mode, reason and
rotation status/reason, including `not_written`/`none`/`not_requested` defaults,
and `covered` (`null` or the types closed by `ledger cover` with reason and
identity hash). A run that both writes and covers keeps the write's status, mode
and rotation. The outcome stays until the run's final commit, so partial commits
log it too.
