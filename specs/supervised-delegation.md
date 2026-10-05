# Optional deadlines and supervised non-blocking Delegation

Spec synthesized by `/to-spec`. The operator confirmed the execution contract and both testing seams. This document specifies future behavior, not currently supported tool parameters.

## Problem Statement

Long-running Delegations currently fail at a fixed timeout even when useful work remains. The retained conversation can survive without a final answer, but the parent cannot treat that failed submission as a safe continuation.

Blocking Delegation also prevents the parent from reasoning while a Sub-agent works. Progress updates in the terminal do not return control to the parent.

The operator needs optional execution deadlines, recoverable pauses, safe conversation reuse, and explicit non-blocking supervision. These capabilities must preserve the native TUI that the operator has already approved. Its layout, colors, tree geometry, indentation, clipping, and expanded alignment are the fixed design system. The rejected browser prototype is not a UI reference.

## Solution

Keep blocking Delegation as the default. Add explicit non-blocking execution that returns a handle and lets the parent supervise the Sub-agent.

Treat an optional execution allowance as a request for a recoverable pause, not a task failure. Preserve unfinished work through a tool-free handoff and permit authorized continuation within the original scope.

Allow completed Sub-agents to accept follow-up tasks in their retained conversations. Distinguish each task's execution identity, results, and usage. Report current context health before reuse.

Only relevant non-blocking Delegations appear sticky immediately above the composer. Reuse the established native agent rows. Do not add a permanent overview dashboard, aggregate counters, notification counters, an empty placeholder, or reserved space. Blocking Delegations remain in the transcript only.

## User Stories

1. As an operator, I want blocking Delegation to remain the default, so that existing workflows keep their behavior.
2. As a parent, I want to start non-blocking Delegation explicitly, so that I can reason while the Sub-agent works.
3. As a parent, I want a stable execution handle, so that I can inspect and control the intended task.
4. As an operator, I want work without an implicit deadline, so that productive tasks are not failed by an arbitrary duration.
5. As a parent, I want to choose an allowance or explicitly choose no deadline, so that the task has the intended policy.
6. As an operator, I want Agent definitions to supply optional default allowances, so that recurring policies do not require repeated input.
7. As a parent, I want my explicit allowance choice to take precedence, so that the current task can differ from its Agent default.
8. As a parent, I want a checkpoint requested before allowance expiry, so that the Sub-agent can preserve useful progress.
9. As an operator, I want the current tool to finish before a safe pause, so that an allowance does not interrupt a workspace mutation halfway through.
10. As an operator, I want new work tools prohibited once pausing begins, so that the Sub-agent cannot extend work beyond the pause boundary.
11. As a parent, I want a tool-free handoff, so that remaining work and limitations are available without further workspace changes.
12. As an operator, I want a stuck tool reported as Pausing, so that the UI does not falsely claim ownership was released.
13. As an operator, I want cancellation available during pausing or handoff, so that an unresponsive operation can be stopped.
14. As a parent, I want bounded transient handoff retries, so that temporary failures do not immediately discard the checkpoint opportunity.
15. As an operator, I want explicit unlimited transient retries as an optional policy, so that I can choose persistence without making it the default.
16. As a parent, I want one corrective turn for empty handoff output, so that an empty response does not immediately lose the handoff.
17. As a parent, I want permanent or exhausted handoff failures reported truthfully, so that I can inspect retained work before deciding what to do.
18. As a parent, I want ordinary allowance pauses continued within their original scope without repeated operator approval, so that supervision remains useful.
19. As a parent, I want to reassess remaining work before continuation, so that repeated pauses do not conceal lack of progress.
20. As a parent, I want a fresh allowance or explicit deadline removal on continuation, so that the next work period has a deliberate policy.
21. As an operator, I want crash recovery and existing failed-run recovery to require approval, so that side effects are not silently repeated.
22. As an operator, I want cancelled tasks to remain stopped, so that cancellation cannot become automatic continuation.
23. As a parent, I want completed Sub-agents to accept follow-up tasks in the same conversation, so that useful context can be reused.
24. As an operator, I want follow-up executions linked to their conversation but separately identified, so that historical results remain intact.
25. As a parent, I want busy Sub-agents to reject new tasks, so that follow-up work is not confused with steering current work.
26. As an operator, I want Agent, model, tools, and workspace fixed during conversation reuse, so that reuse cannot widen authority or change identity.
27. As a parent, I want current context estimates and model capacity reported before reuse, so that I can judge conversation health.
28. As a parent, I want explicit warnings and fresh-conversation recommendations, so that long histories do not silently degrade task quality.
29. As a parent, I want unknown context measurements reported as unknown, so that cumulative billed tokens are not mistaken for current context size.
30. As a parent, I want compaction to be explicit and its outcome reported, so that conversation changes are visible rather than silent resets.
31. As a parent, I want bounded waits, so that waiting for progress does not indefinitely occupy my reasoning turn.
32. As an operator, I want wait expiry to leave the Sub-agent working, so that a supervision window is not mistaken for an execution deadline.
33. As a parent, I want to steer at a safe turn or tool boundary, so that guidance can influence ongoing work.
34. As a parent, I want steering acceptance and consumption reported separately, so that queue acceptance is not mistaken for obedience.
35. As a parent, I want completion, failure, pause, and concrete blocker notifications, so that I can act on meaningful changes.
36. As an operator, I want notifications queued while the parent is busy, so that updates arrive at a usable parent boundary.
37. As a parent, I want a bounded final answer delivered with completion and full retrieval available, so that I can react without dumping the entire history into context.
38. As an operator, I want delivery and usage deduplicated, so that repeated inspection does not duplicate answers or costs.
39. As a parent, I want Ordered and Chain dependencies held while a Sub-agent is paused, so that unfinished work is not used as a final answer.
40. As a parent, I want Parallel siblings to continue independently, so that one pause does not stop unrelated work.
41. As an operator, I want safely paused work to release workspace ownership, so that another authorized execution can use the workspace.
42. As an operator, I want continuation and follow-up to reacquire ownership, so that workspace conflicts are detected before work restarts.
43. As an operator, I want an active-child capacity limit and explicit busy responses, so that work does not silently accumulate in a hidden queue.
44. As an operator, I want Sub-agents owned by the current Pi session, so that closing or replacing that session stops its work.
45. As an operator, I want reopening a session to leave interrupted work stopped, so that recovery remains deliberate.
46. As an operator, I want the approved native TUI preserved exactly, so that the new feature does not undo established alignment or visual behavior.
47. As an operator, I want only non-blocking Delegations sticky above the composer, so that blocking work does not add redundant UI.
48. As an operator, I want that area to stay fixed while transcript content scrolls, so that ongoing non-blocking work remains visible.
49. As an operator, I want paused non-blocking work to remain visible, so that unfinished work is not forgotten.
50. As an operator, I want delivered completed work removed from the sticky area, so that the composer is not surrounded by stale results.
51. As an operator, I want the sticky area absent when no relevant work remains, so that no empty dashboard or spacing persists.
52. As an operator, I want Durable, Tasks, and pstack independently usable, so that supervision introduces no hard package coupling.

## Implementation Decisions

### Execution policy and lifecycle

- An explicit parent duration or explicit no-deadline choice takes precedence over the Agent definition's `timeoutMinutes`. If neither supplies an allowance, there is no execution deadline.
- Remove the packaged poteto Agent's explicit 30-minute default through its owning package. Do not introduce a Durable dependency into that package.
- A supervision wait duration and an execution allowance are distinct. Wait defaults to 60 seconds with an explicit override. Wait expiry returns parent control without pausing or cancelling the Sub-agent.
- Add Work, Pausing, Preparing handoff, and Paused as execution phases. Do not collapse allowance pause into Failed, deliberate cancellation into Failed, or Interrupted into an ordinary allowance pause.
- Request a checkpoint before expiry. At the pause boundary, prevent new work tools from starting. Allow the current tool to finish, then prepare the handoff.
- Enforce tool-free handoff in the host. Prompt instructions alone do not satisfy this contract. Provide a final model turn without a separate handoff wall-clock cap.
- A stuck tool retains ownership and stays Pausing until it finishes or cancellation stops it. Never advertise a safe pause while that tool remains active.
- Allow up to three transient-failure retries with backoff and one corrective empty-output turn. Permanent failure stops retrying. Explicit unlimited transient retries are optional and remain subject to session closure and cancellation.
- Do not multiply retry budgets by stacking a second retry loop over SDK retries. Failed handoff leaves the task paused with retained work and an explicit limitation.
- Ordinary allowance continuation is authorized for the parent within the original scope. Require reassessment and a fresh allowance or explicit deadline removal. Escalate repeated pauses without useful progress.
- Crash recovery and continuation of historical failed work require explicit operator approval. Do not reinterpret failed metadata as interrupted metadata or replay an unanswered submission blindly. Cancelled work remains stopped.
- Children remain in-process and owned by their invoking Pi session. Closure or replacement suspends active work. Reopening does not automatically execute recovery.

### Controls and conversation reuse

- Expose conceptual start, status, wait, steer, continue, cancel, and follow-up capabilities. Exact names and schemas are implementation work, not inferred from prototype buttons.
- Keep the existing blocking call path compatible. Explicit non-blocking start returns an execution handle without retaining the parent's reasoning turn.
- Preserve permission and adapter lifetimes after a non-blocking tool call returns. Returning a handle must not leave the Sub-agent with expired parent-bound tool access.
- Steering queues guidance for a safe boundary. Queue acceptance does not prove consumption or obedience. Steering does not interrupt a running shell command.
- A new task on a completed Sub-agent reuses the conversation by default, with a new execution identity linked to that conversation. Preserve earlier results and charge only the new execution's usage delta.
- Fix Agent, model, tools, and workspace for reused conversations. Reacquire ownership before follow-up execution. Reject a new task while the Sub-agent is busy. Use steering for changes to current work.
- Before reuse, report the current context estimate, model capacity, and compaction state. Do not substitute cumulative billed tokens for current context size.
- Warn at the lower of 120,000 tokens and 80% of the model window. Recommend a fresh conversation at the lower of 150,000 tokens and 95% of the window. After a warning, require an explicit parent reuse decision. Unknown estimates remain unknown.
- Compaction requires an explicit request and reports its outcome. Do not silently reset the conversation or claim that compaction restores reasoning quality.

### Notifications, ownership, and groups

- Queue completion, failure, pause, concrete blocker, and deduplicated stall-attention events at usable parent boundaries. Ordinary progress is UI-only.
- Deliver a bounded final answer with completion. Preserve full retrieval. Deduplicate event delivery and accounting across polling, recovery, and historical retrieval.
- Safely paused and completed work release ownership. Work, Pausing, handoff preparation, and handoff retries retain ownership until safe release.
- Continuation reacquires ownership and capacity before work. Parent writes cannot run concurrently in the Sub-agent's owned workspace. Use separate worktrees for concurrent writers. Tool selection is not a shell or filesystem sandbox.
- Ordered and Chain dependencies remain pending on pause. A handoff cannot become the Chain's final answer. Parallel siblings continue independently. Paused work is not done, and its recorded costs remain included.
- Default to eight actively executing Sub-agents per owning session, configurable by the operator. Handoff and retry consume capacity. Safely paused and completed work do not. Return busy at capacity without a hidden queue.
- Keep the eight-step batch bound and opt-in nesting depth of three separate from execution capacity.

### Fixed native design system

- Treat the current approved native renderer as authoritative. Reuse its rendering primitives, width calculations, expansion model, and layout rules for new phases and sticky placement. Do not copy browser prototype markup or indentation.
- Preserve no-background rendering and the absence of an initial call-preview flash. Preserve bold colored Agent names, separate state colors, explicitly white connectors, and recorded rather than estimated cost.
- Preserve normalized task captions capped at 50 Unicode code points including ellipsis, with width-aware clipping. Expanded task text remains complete.
- Preserve the single heading's one-space inset and its metrics connector's four-space inset. Preserve the complete group's one-space outer inset without changing internal tree geometry.
- Preserve aligned expanded task, Markdown answer, continuation lines, separators, and metrics in single, Ordered, Chain, and Parallel layouts at different widths.
- Preserve manual expansion, initial collapse, expansion across updates, regular Ctrl+O, fullscreen child-header click behavior, lifecycle-owned spinner timers, and bounded running activity.
- Add Pausing, Preparing handoff, and Paused through existing status conventions. New states do not authorize a visual redesign.
- Place only relevant non-blocking Delegations sticky immediately above the composer. The transcript scrolls independently. Blocking Delegations never appear in this area.
- Keep active, pausing, handoff, and paused non-blocking work visible. Remove completed work after result delivery. Keep full task, activity, and responses available in the transcript or management surface.
- When no relevant non-blocking work remains, remove the entire area, including dividers and reserved height. No permanent “Delegation Overview” heading, global capacity counters, aggregate accounting dashboard, notification counters, or empty placeholder.
- Reuse the native row design and expansion geometry rather than create a second design system for sticky content.

### Persistence and package boundaries

- Extend the durable record model to distinguish conversation identity, execution identity, pause reason, handoff, recovery authorization, result delivery, and usage deltas. Preserve historical results and old record readability.
- Existing stored failures remain failures until an explicitly approved recovery action. Preserve existing worktree, nesting, allowlist, model-resolution, and configuration-preservation contracts.
- Keep Durable, session-native Tasks, and pstack independent. No child-to-parent Tasks bridge or competing delegation engine.
- Keep the current local production baseline intact. Separate repository publication, owner, visibility, and installation migration are not authorized by this feature spec.

## Testing Decisions

### Confirmed testing seams

1. **Delegation behavior through the host tool and retained-session boundary.** Prefer existing scripted-provider and disposable-workspace integration fixtures. Exercise blocking and non-blocking requests through the same public entry point used by the parent. Keep provider scheduling controllable without duplicating the runtime in a test model.
2. **Actual Pi terminal surface.** Extend existing native PTY probes and literal renderer expectations. Verify the established inline system and the new sticky placement on the real host, not browser approximations.

Keep lower-level tests only where these two seams cannot isolate malformed requests, persisted-record compatibility, or accounting correctness. Do not add test-only lifecycle abstractions merely to mirror implementation functions.

### Behavioral acceptance

- Prove no implicit execution deadline, explicit policy precedence, and compatibility of blocking calls.
- Use observable workspace effects to prove that allowance expiry during a tool blocks subsequent work tools, waits for the current tool, and allows no work tools during handoff. Verify continued work rather than only checking a state label.
- Cover successful handoff, transient retry exhaustion, explicit unlimited retries, permanent errors, one empty-output correction, cancellation, and owner-session closure. Verify the effective retry budget without multiplying SDK retries.
- Verify a timed-out parent wait returns while the Sub-agent still makes useful progress. Verify the parent can reason, inspect, and steer after non-blocking start returns.
- Verify adapters, tool authorization, ownership, and error reporting remain valid after that return.
- Exercise allowance continuation, crash recovery, historical failed recovery, and cancellation separately. Verify no tool side effect is replayed and no recovery runs without required approval.
- Verify follow-up execution identity changes while conversation identity and fixed Agent authority remain stable. Retrieve old and new answers, then retrieve them again to prove preservation and no rebilling.
- Test context decisions on both sides of each threshold, on smaller model windows, and with unknown measurements. Assert explicit reuse gating and truthful compaction outcomes.
- Verify steering acceptance, later consumption, and observed behavior separately. A queued acknowledgment alone is not an obedience test.
- Hold the parent busy during completion, then release it. Verify bounded answer delivery, full retrieval, and deduplication across repeated status and recovery operations.
- Verify paused Ordered and Chain work does not start dependent work. Verify a Parallel sibling continues. Assert recorded group usage and truthful done counts.
- Fill capacity with active or handoff work, reject another request, safely pause one task, and start new work. Verify continuation conflicts when capacity or workspace ownership is unavailable.
- On the native terminal, verify blocking-only work produces no sticky area. Start non-blocking work and scroll the transcript. Verify the rows remain immediately above the composer.
- Verify paused non-blocking work stays visible, delivered completed work disappears, and the area leaves no divider or height when empty.
- Check exact existing indentation and expanded continuation alignment for single, Ordered, Chain, and Parallel rows. Cover 80 and 120 columns, resize, dark and light themes, regular and fullscreen modes, expansion persistence, header hit areas, and unchanged background behavior.
- Stop and reopen an owning session. Verify interrupted work stays stopped. Run an explicitly approved recovery separately.
- Run the existing full Durable regression suite and independent Tasks and pstack checks. A browser walkthrough or scripted provider cannot replace native-host and installed-SDK evidence.

A good test asserts externally observed results, workspace effects, usage, permission outcomes, or terminal output against literal expectations. It does not assert only that a mock was called, a constant exists, or a fixture matches itself.

## Out of Scope

- Further prototype work or promotion of the rejected browser layout.
- Redesigning the approved native TUI, changing indentation, or adding a permanent supervision dashboard.
- Detached background execution, daemons, or tasks that survive Pi closure.
- Automatic crash recovery, continuation of cancelled tasks, or silent recovery of historical failures.
- Agent, model, tool, or workspace changes during retained-conversation reuse.
- General shell isolation, filesystem sandboxing, comprehensive secret redaction, or guaranteed model obedience.
- Silent compaction, automatic conversation reset, or guaranteed reasoning-quality restoration.
- SQLite maintenance, unrelated package cleanup, releases, publication, pushes, or installation migration.
- Hard integration between Durable, Tasks, and pstack.

## Further Notes

The confirmed conversation is the source for execution policy. The operator's later corrections supersede all prototype presentation choices. The prototype is neither visual acceptance evidence nor implementation code to reuse.

The production starting point is tagged `baseline-current` at `b30a85b`. The abandoned prototype is separately recorded on `prototype/supervised-delegation`. This spec does not require deleting that history or altering production.

The operator authorized a public standalone repository at `ZayRTun/Pi-Durable-Subagent`. This repository owns the spec and its implementation tickets. The existing issues were transferred from `ZayRTun/Pi-Agent`, preserving their history. The spec is issue #1; implementation tickets are issues #2 through #12. Repository creation and issue transfer are authorized maintenance work, separate from feature implementation or migration of the active installation.

The current domain glossary describes blocking-only execution and timeout failure. Those definitions describe the baseline, not the proposed contract. Update the domain documentation with implementation rather than silently treat new phases as existing Run States.

Research reference: the retained delegation-timeouts research report. Native design reference: the approved final production renderer, its regression tests, and final no-background/group-inset acceptance evidence. Earlier screenshots with backgrounds and the browser prototype do not supersede that system.
