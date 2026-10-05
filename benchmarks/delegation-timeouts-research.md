# Delegation timeouts, continuation, and supervision

## Decision briefing

Research only. No runtime, Agent definition, operator configuration, or recovery state was changed. No failed delegation was resumed, and no paid child probes were run. The research delegate could not start because another delegation held the workspace lock; source investigation was performed directly. Throughput checkpoint: n/a, read-only investigation.

**Recommendation:** replace the implicit 30-minute terminal-failure policy with explicit execution policy. Long-running workers should be able to have no automatic execution deadline. Keep user cancellation, Pi-shutdown suspension, admission locks, and explicit recovery approval. Add non-destructive attention signals and recoverable continuation before adding autonomous parent supervision. Optional deadlines should request a checkpoint first and preserve continuation rather than make useful work permanently unrecoverable through the public tool.

This is not a recommendation to copy another extension's execution engine or introduce detached background processes without approval.

## What happened in the reported run

A read-only inspection found a matching `poteto-agent` run, ID `deac2d9f9711ce02c2a5d0ad926ef809`:

| Recorded observation | Value |
|---|---:|
| Status/error | failed / Timed out after 30 minutes |
| Elapsed | 1,800,007 ms |
| Tool calls | 161 |
| Recorded cumulative tokens | 14,605,374 |
| Recorded cost | approximately $0.13395 |
| Final output in metadata | 0 characters |
| SQLite size | 1,277,952 bytes |
| Persisted transcript entries | 298 |
| Assistant / tool-result entries | 135 / 161 |
| Submission state | unanswered |

The cumulative token figure includes repeated context/cache accounting; it is not the size of one prompt. The database was opened read-only and only counts/statuses were reported, not task text, file contents, commands, or credentials. All 135 persisted assistant messages have `toolUse` stop reasons; seven text blocks totaling 360 characters also exist. There is no final answer in the metadata. This does not establish whether the project work was correct or how much could be salvaged, because workspace effects and tool payloads were not audited.

**The job was not entirely erased.** Durable still has the transcript, tool results, and usage. Files/external side effects are not rolled back by timeout. The defect is the combination of an abrupt stop, no useful final handoff, and no supported continuation of that failed run.

Local evidence lives under `$HOME/.pi/agent/sessions/durable-subagents/<run-id>/`. Do not modify that directory or delete SQLite companions to attempt recovery.

## Durable's current mechanism

- The parser defaults `timeoutMinutes` to 30 and accepts only finite values from 1 to 480. The package-owned poteto definition also explicitly sets `timeoutMinutes: 30`. Changing only the parser default would not change poteto's timeout. [D1]
- Runtime starts an absolute timer for each execution attempt. Activity does not renew it. The timer aborts the wait with reason `timeout`. [D2]
- Catch maps timeout to `failed` and calls `root.abort()`. Shutdown and lost-lock reasons instead map to `interrupted` and do not take that terminal-abort path. [D2]
- Terminal cached results return immediately. `resume` of a failed run retrieves it; it does not start more work. [D3]
- `run.output` is populated from the settled final answer. The timeout path does not extract a handoff from the transcript. Final accounting still reads the durable usage ledger and saves metadata. [D2]
- The original submission has stable request ID `delegation:<run-id>`. For this already-failed run the submission is now unanswered. Flipping metadata to `interrupted` is not a valid continuation implementation: reusing that settled request would not magically restore active work. A supported continuation would need a new, explicitly approved input in the retained conversation, plus defined side-effect and billing semantics. [D2, D3, D4]

A deadline is a defensible guard against endless loops and stuck tools, but 30 minutes is an extension/Agent policy, not a Pi requirement. The poteto policy was preserved with the packaged Agent definition. Elapsed time alone does not tell us whether the task is making useful progress.

## How other Pi implementations behave

Sources were pinned when fetched. These conclusions concern the inspected revisions, not every released version.

| Implementation | Execution duration policy | Observation/control | Retention/recovery |
|---|---|---|---|
| `nicobailon/pi-subagents`, manifest 0.76.0, `ba008223698e78ff71d75ed83076d858d14d9eee` | Foreground launches and plain async single-Agent launches default to 30 minutes; explicit call/Agent/config values can extend it. Async composite top-level runs can be unbounded while children remain individually bounded. Explicit zero is rejected, not treated as unlimited. | Background status, attention notifications, acknowledged steering, follow-up queues, waiting windows, and optional pre-deadline checkpoint steer. | Captures unfinished streamed text on timeout, retains session identity, and supports explicit revival of eligible failed/paused/completed children. Original absolute workflow deadlines can still bar recovery. [N1–N5] |
| Official Pi subagent example, `b9ab918c626ad3dd5edb58de037540f9467def88` | No extension-wide runtime deadline in the inspected `runSingleAgent` path. Waits for subprocess completion or parent abort. | Streaming JSON output; no live steering API in that example. Parent abort triggers process termination. | Launches with `--no-session`; this is a minimal example, not durable resumable-job infrastructure. [P1] |
| `mitsuhiko/agent-stuff` tmux subagent, `0865c849befd2021490679f96a8dee58c84ac857` | No whole-job deadline in the inspected wait loop. Five-second timeouts cover tmux inspection commands, not the delegated task's total runtime. | Polls the pane and offers manual interactive attachment. Parent cancellation/shutdown controls the child process. | Reports/preserves a child session file. No equivalent automatic supervisor tool was found in the inspected single-file interface. [M1] |

Absence of an extension-wide deadline does not disable provider HTTP limits, individual tool limits, cancellation, or host shutdown behavior.

### Important findings from nicobailon/pi-subagents

1. **The cited extension also has a 30-minute default.** It is not unlimited by default. Global/call `timeoutMs` are positive integers capped at Node's maximum timer delay. Setting zero does not disable the run deadline. [N1]
2. **A waiting window is not an execution deadline.** `bg_wait` can return `window_elapsed` without error while work continues. Attention or completion can wake the parent separately. This is the essential distinction for a supervision design. [N2]
3. **Checkpointing is best effort.** `checkpointBeforeDeadlineMs`, for async single runs, steers the child to finish its current tool and report changed files, test/build state, remaining work, and commit/PR state. It does not remove the final hard deadline. A blocked tool can prevent delivery. The source tests cover both a delivered handoff and a timeout with unconsumed steering. Those tests were inspected, not rerun here. [N3]
4. **Timeout text is preserved more usefully.** The runner retains latest unfinished assistant text and labels it `Partial output before timeout`. This is not proof that an internal thought process or a tool's uncommitted effects can be recovered. [N4]
5. **Failed does not always mean no more conversation.** Eligible retained native sessions can receive an explicit resume/follow-up. The code requires valid session/recovery identity and rejects deliberately stopped children. Revival starts a new execution receipt using the retained session file. Recovery with an already-expired inherited absolute deadline is rejected. [N5]
6. **Attention is not an automatic kill.** Control code distinguishes no recent activity from a long-open tool and adjusts default no-activity thresholds for thinking level. Such signals help inspection, but do not prove a hang. [N6]

## Can the parent check in and nudge?

**The underlying APIs support input while a child is busy; our public Durable interface currently does not.**

The installed Pi SDK defines `steer()` as delivery after the current assistant turn finishes its tools, before the next model call. `followUp()` waits until there are no more tool calls or steering messages. Queue acceptance is not proof that the child read or obeyed the message. Neither action cancels a running shell command. [S1]

Pi Durable's conversation API likewise accepts `submit({type: "input", whenBusy: "steer" | "followUp" | "reject"})` and durably queues busy input. Its structural view supports observation. This is a plausible native implementation seam, not a reason to switch runtimes. [S2]

**The parent-model scheduling problem is separate.** Our current `subagent` tool blocks until the child finishes, and the runtime owns its execution adapters and harness within that invocation. Progress reaches the UI, not a new parent-model turn. The parent cannot spontaneously reason about a progress update and issue another control tool while it is waiting for that same blocking call. Steering the parent session is also not equivalent to steering the child.

Possible designs:

- Keep blocking execution and add a runtime-owned observer/checkpoint controller. This can produce useful notices or predetermined steering without pretending the parent model has checked in.
- Pause at a safe boundary and return an attention/handoff result. The parent can decide whether to continue explicitly. This retains a blocking ownership model but pauses work instead of supervising it concurrently.
- Add supervised in-process run handles, bounded wait calls, status/steer controls, and event delivery so the parent regains control while the child works. This requires deliberate ownership, valid tool-context/permission lifetimes, locking, final-result delivery, and accounting. It must still stop with Pi unless separately approved. Simply returning early from today's implementation would release/close the resources the child needs.

A detached runner that survives Pi closure is a different, larger lifecycle change. It is not required merely to fix a destructive 30-minute default.

## Recommended policy and sequence

| Option | Benefit | Limitation | Judgment |
|---|---|---|---|
| Raise 30 minutes to several hours | Small temporary mitigation | Still an abrupt arbitrary cutoff; no handoff/continuation | Useful only as an explicitly requested stopgap |
| Disable deadline and change nothing else | Productive tasks can finish | Infinite loops, runaway cost, and wedged tools remain possible | Incomplete by itself |
| No implicit kill + attention + explicit cancellation/continuation | Avoids destroying active work; keeps operator control | Attention heuristics need calibration | Recommended baseline for long workers |
| Optional deadline + checkpoint/grace + recoverable pause | Explicit time budgets without terminally losing context | Tool/model boundary delivery is not instant; uncertain effects remain | Recommended when a caller requests a budget |
| Parent supervision with bounded waits/steering | Parent can inspect progress and adapt plans | New control/lifecycle contract; substantially larger scope | Design separately after preservation is fixed |

Suggested delivery order, requiring approval before implementation:

1. Preserve existing timed-out runs and provide transcript/result inspection and an explicit, safe continuation path. For already-aborted submissions, create a new input in the same conversation; do not falsify metadata or replay unknown tool effects.
2. Represent execution policy explicitly, including a genuine no-deadline option for long workers. Decide Agent/config/call precedence and update the explicit poteto policy, not just a parser fallback. Preserve older stored definitions as historical facts.
3. Add attention thresholds based on actual model/tool lifecycle activity, not TUI heartbeat timestamps. Warn about long tools/repeated failures, and avoid treating long thinking/builds as confirmed hangs. Progressing loops can still spend indefinitely, so explicit cost/tool budgets are complementary safeguards.
4. For requested deadlines, request a checkpoint early, allow a clearly defined grace/boundary policy, and retain the transcript/partial answer and continuation state if a stop is necessary. Existing cooperative cancellation cannot promise immediate or mutation-safe stopping.
5. Add parent status/steering/short waits only after agreeing whether concurrent in-process supervision is wanted. Keep explicit approval, no automatic restart, no permission widening, no new pstack dependency, and accurate usage deltas.

## Verification criteria for a future implementation

Use scripted/offline providers and disposable workspaces for these checks:

- A healthy long-running child continues beyond the old deadline when unlimited is selected.
- Missing activity causes attention, not automatic data loss.
- Queued versus consumed steering is distinguished; nudges do not silently stop long tools.
- A requested deadline checkpoints when possible and remains explicitly continuable when it cannot.
- Both preserved interrupted work and already-terminal timeout conversations have well-defined continuation behavior.
- Unknown side effects are never silently replayed; workspace admission and frozen permissions remain enforced.
- Pi close/reopen does not restart work automatically; no child continues beyond Pi's lifetime without separate authorization.
- Historical usage is not billed again, including retained-conversation continuation and grouped results.
- Native UI preserves the approved background, caption, tree, and indentation behavior.

## Sources

### Local authoritative code

- **D1:** `agent/durable-subagent/agents.ts:36–39`; `$HOME/code/pi-pstack-custom/packages/pi-pstack/agents/poteto-agent.md:7`.
- **D2:** `agent/durable-subagent/runtime.ts:223–282` (timer, stable submission, final answer, failure mapping, abort, accounting/close).
- **D3:** `agent/durable-subagent/runtime.ts:110–118`; `index.ts:127–133` (terminal retrieval).
- **D4:** `agent/durable-subagent/usage.ts:19–48` (delivered-history usage deltas), plus read-only incident metadata and database aggregates described above.
- **S1:** installed Pi 1.0.3 `docs/sdk.md`, Prompting and Session lifecycle; `dist/core/agent-session.d.ts:517–539`. Locate under the installed `@earendil-works/pi-coding-agent` package.
- **S2:** `agent/durable-subagent/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:15–27, 430–476` (busy input, abort, watch, scheduling). This is the currently pinned dependency contract, not a live control probe.

### Fixed upstream revisions

- **N1:** [Timeout config](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/docs/configuration.md#L337-L350), [resolution code](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/foreground/subagent-executor.ts#L2958-L3036), and [default tests](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/test/unit/timeout-defaults.test.ts#L10-L118).
- **N2:** [Wait windows](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/docs/configuration.md#L307-L317).
- **N3:** [Checkpoint contract](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/docs/configuration.md#L363-L373), [runner implementation](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/background/subagent-runner.ts#L3406-L3436), and [checkpoint tests](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/test/integration/deadline-checkpoint.test.ts#L24-L128).
- **N4:** [Partial output tracker](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/shared/partial-output.ts), [timeout result construction](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/background/run-child-session.ts#L584-L643).
- **N5:** [Revival eligibility](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/background/async-resume.ts#L488-L608), [retained-session launch](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/foreground/subagent-executor.ts#L2230-L2299), and [expired absolute deadline guard](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/background/async-execution.ts#L1952-L1956).
- **N6:** [Attention policy](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/shared/subagent-control.ts#L17-L124), [steer delivery](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/src/runs/background/run-child-session.ts#L674-L711), [open-tool limits](https://github.com/nicobailon/pi-subagents/blob/ba008223698e78ff71d75ed83076d858d14d9eee/docs/observability.md#L5-L13).
- **P1:** [Official example launch/cancellation](https://github.com/earendil-works/pi/blob/b9ab918c626ad3dd5edb58de037540f9467def88/packages/coding-agent/examples/extensions/subagent/index.ts#L278-L442).
- **M1:** [Tmux child launch and wait](https://github.com/mitsuhiko/agent-stuff/blob/0865c849befd2021490679f96a8dee58c84ac857/extensions/subagent.ts#L530-L638).

## Evidence and limitations

Pinned clones are under `/tmp/pi-subagent-timeout-research-UqMaxI/`, with pointer `/tmp/pi-subagent-timeout-research-path.txt`. Source behavior and upstream tests were inspected; other extensions were not installed or executed. No automated recovery was attempted. The incident's underlying transcript was inspected only for structural aggregates. This report does not prove that all project effects can be recovered, or that any proposed supervision mechanism works end to end before it is implemented and tested.
