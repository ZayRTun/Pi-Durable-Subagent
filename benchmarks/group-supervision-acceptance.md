# Group supervision acceptance (#11)

The approved seams are the installed Pi host/session and the actual native terminal. Tests use the production Runtime execution engine and SDK-retained conversations, with a faux provider at the model boundary. No paid model calls, installation migration, publication, or customer data are involved.

## Public host/session evidence

`test/pi-groups.test.ts` covers:

- Blocking Chain: the first child pauses after a controlled real host-tool boundary; its dependent stays Pending. SDK reload preserves the stopped graph and makes no new tool call. Explicit child continuation retains the original Agent definition despite editing the definition file, does not replay the completed tool, and advances the next child with only the genuine final answer. The handoff is absent from the dependent's input.
- Nonblocking Ordered: the start tool returns a distinct group handle and both child handles. A failed handoff still leaves a Paused child and a Pending dependency. An independent execution can own the original workspace; attempting continuation then fails admission and preserves the stopped dependency graph. Cancelling only the unstarted child returns its own Not run state and leaves the predecessor Paused. Cancelling the group aborts its started child without creating an unstarted Run.
- Nonblocking Parallel: four isolated checkouts independently produce Paused, Succeeded, Failed, and Aborted children. Targeted cancellation affects only its child. Management retrieval bills only newly accrued usage; repeated retrieval changes neither recorded cost nor billing.
- Capacity: with one active slot and two isolated parallel children, one child executes and the excess child's admission failure explicitly says busy/no work queued. Inspection after release does not start the rejected child.

The initial Chain regression failed with two child Runs after the first paused. The refused-continuation regression also failed before the fix: it silently returned a paused group after converting dependencies to Not run. Both pass with explicit stopped-group supervision.

Validation: combined integration suite passed **175 tests**, then the focused host/notification/group/TUI suite passed **27 tests**. `npm run typecheck` passes. The combined suite includes #9 context health/compaction and #8 notification delivery; group code reuses those implementations.

## Actual native terminal evidence

`test/fixtures/tui-redesign-probe.py` launches the installed offline `pi` CLI on a real PTY. It uses the established native fixture and renderer, including SDK Ctrl+O and mouse dispatch. Controlled allowance timers scale one minute to 1.8 seconds; fixture tools read three real disposable files, then wait synthetically.

| Scenario | Native environment | Evidence |
| --- | --- | --- |
| Ordered pause/cancel | 120 columns, light, regular | `/tmp/durable-tui-group-ordered-120b/acceptance.json` |
| Chain pause/continue/failure | 80 columns, dark, fullscreen | `/tmp/durable-tui-group-chain-80e/acceptance.json` |
| Parallel pause/independent success/failure/cancel | 120 columns, light, fullscreen | `/tmp/durable-tui-group-parallel-120b/acceptance.json` |

Each directory contains raw ANSI and captured viewports. The probe checks group headings, a one-space outer inset, running animation, native expansion, per-child mouse expansion in fullscreen, resize to 80/120 columns with default-background truncation, and paused sticky retention. Ordered/Chain pause reads 0/3 done with dependencies Pending. Parallel reads 2/3 done while its paused sibling remains visible. Chain continuation runs all dependencies, preserves completed Markdown bullet continuation columns and code blocks, and removes the sticky area after retained child completion receipts. Group status/cancel use the same self-rendered group primitive, avoiding extra host padding. Cached nonblocking start snapshots remain in the transcript; later status reports the current graph.

Blocking groups use the same execution graph but stay transcript-only. The existing `chain` PTY scenario was also exercised as a regression. Persistent RendererState retains native child expansion across progress and resize; no group-specific layout or competing execution engine was introduced.

## API and lifecycle

`Runtime` stores requested group graphs separately in `.groups/<group-id>.json`. Children retain `groupId`, frozen definitions, models, authority declarations, original workspace, allowance, and stable execution handles. Group records store all requested steps, including those without a Run, so reopening cannot silently restart dependents. Only explicit continuation/recovery of a recorded child can reenter the group. Chain rewrite uses the original requested task plus the predecessor's successful output, making preparation idempotent.

`subagent_status`, `subagent_wait`, and `subagent_cancel` accept group or child handles. Group replies list each requested child and its actual state; unstarted child replies distinguish Pending from Not run. Group management accounting sums per-child `usageToReport` deltas. Sticky completion removal consults #8's retained-message delivery ledger for every terminal child; paused groups remain. Owner shutdown stops actual children first, then awaits group supervisors, without starting pending dependencies.
