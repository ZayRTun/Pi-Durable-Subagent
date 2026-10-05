# Continuation and explicit recovery

Ticket #5; spec #1. The public host/retained-session seam exercises the original native subagent tool.

`subagent({resume: id})` retrieves safely paused or completed work. Ordinary allowance continuation requires `reassessment` and a fresh `timeoutMinutes` (1–480) or explicit `null`. `/subagents` offers Continue for paused work and asks the parent to reassess and choose policy. Interrupted and failed recovery require the existing operator confirmation or `--subagent-resume id`. Reopening does not execute recovery. Failed metadata remains Failed until approved; approved recovery retains its previous error in `recoveryHistory` and submits a fresh recovery instruction instead of the cached unanswered submission. Cancelled work stays stopped.

Host fixtures demonstrate retained identity/history, original tool restoration, only the new continuation tool call executes, and only additional recorded usage is billed. Existing SDK shutdown/reopen and real CLI SIGKILL tests separately cover explicit crash recovery, stale leases and unsafe-tool non-replay. Existing cancellation fixtures cover stopped work. No renderer primitives, native colors or row geometry changed.

Admission uses the same execution entry point and workspace locks as original work; failed admission leaves stopped metadata untouched. Ticket #6 adds the common active capacity gate. Every allowance/handoff submission has an execution-attempt identity so a later pause cannot retrieve an earlier handoff.

Progress escalation conservatively counts new work-tool calls; two successive pauses without a new call require operator approval of the revised reassessment. Tool-free reasoning can be useful, so the escalation is an attention request rather than a claim that no reasoning occurred. Operator-approved continuation resets that escalation window.
