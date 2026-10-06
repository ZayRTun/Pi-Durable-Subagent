# Durable Delegation

This context defines how a Pi parent assigns work to Sub-agents, supervises its progress, and retrieves its results.

## Work and identity

**Agent**:
A named set of instructions, tool permissions, and optional model preferences used to start delegated work.

**Conversation**:
The retained model context that can inform one or more executions.

**Execution**:
One task performed by an Agent, with its own lifecycle state, result, and attributable usage. In the interface and stored history, an execution is a Run.

**Execution attempt**:
A particular attempt to perform or recover an Execution. Recovery adds an attempt while preserving the earlier attempt's outcome and history.

**Follow-up**:
A new Execution that may use a completed Execution's retained Conversation while keeping a distinct identity, result, and usage.

## Lifecycle and supervision

**Running**:
An Execution is actively working under its current allowance.

**Execution allowance**:
An optional amount of work time after which an Execution must reach a safe pause. It does not bound how long the parent waits for a result.

**Supervision wait**:
A bounded period during which the parent waits for an Execution update. When it expires, the Execution continues unchanged.

**Pausing**:
The phase after an allowance expires while an admitted tool finishes. Workspace ownership remains held and new work tools cannot begin.

**Preparing handoff**:
The phase after work tools drain, when the Sub-agent prepares a tool-free checkpoint of progress, remaining work, and limitations.

**Handoff**:
A checkpoint produced at a pause boundary. It is distinct from the final answer to the assigned task.

**Paused**:
An unfinished Execution with a retained handoff or an explicit handoff limitation. It is stopped and releases workspace ownership.

**Succeeded**:
An Execution completed its assigned task and produced its final answer.

**Failed**:
An Execution stopped unsuccessfully. A failed Execution remains distinct from allowance-paused, cancelled, and interrupted work.

**Cancelled**:
An Execution deliberately stopped by cancellation. Cancellation does not undo completed effects and cannot be continued automatically.

**Interrupted**:
An Execution stopped because its owning Pi session closed or lost ownership. Reopening the session does not restart it.

**Continuation**:
Resumption of allowance-paused work within its original scope after a parent reassessment and a fresh allowance choice.

**Recovery**:
An operator-approved attempt to continue interrupted or failed work while preserving its recorded outcomes and uncertain effects. Cancelled work is not recoverable.

**Steering**:
Guidance queued by the parent for an active Execution to receive at a safe model or tool boundary. Acceptance means it was queued; consumption means it was inserted into the conversation, not that it was obeyed.

## Context and history

**Context estimate**:
An approximate measure of retained committed model context. It is not cumulative billed usage and may be unknown.

**Explicit compaction**:
A requested summarization of an idle retained Conversation. Its outcome is reported as applied, no-op, or failed; compaction does not promise restored reasoning quality.

**Execution usage**:
Model spend attributable to one Execution attempt or explicit compaction operation, accounted separately from prior Conversation history.

**Execution history**:
The retained results and lifecycle records for an Execution and its attempts. Retrieving that history does not create new work or bill the same usage again.

## Coordination

**Workspace ownership**:
The exclusive right of admitted work to use a working directory until it completes, safely pauses, is cancelled, or is interrupted. This is coordination, not a shell or filesystem sandbox. While it is held, the parent may still use declared read-only host tools and session-only controls such as Tasks; writes to the owned workspace remain blocked.

**Active capacity**:
The maximum number of executions a Pi session admits at once. Work that cannot be admitted is reported busy rather than placed in a hidden queue.

**Supervised group**:
An ordered, chained, or parallel set of Executions coordinated and presented as one request.

**Group dependency**:
A relationship that determines when a requested group member may start. Ordered and Chain work waits for the preceding execution's successful final answer; a handoff is not a final answer. Parallel siblings proceed independently.

**Notification receipt**:
Evidence that a retained parent-facing notification was delivered. Queue acceptance alone is not delivery.

**Informational notification usage**:
Usage metadata attached to a notification for inspection. It does not itself add a standard Pi model-usage charge; management results report any newly accrued execution usage through the normal host accounting path.
