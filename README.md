# Pi Durable subagents

A minimal in-process Pi 1.0 extension for blocking or explicitly supervised delegation to named agents, with retained Sub-agent conversations and explicit recovery. Built on `@earendil-works/pi-durable`, not on a third-party subagent extension.

## Repository and issue tracker

The standalone repository is [ZayRTun/Pi-Durable-Subagent](https://github.com/ZayRTun/Pi-Durable-Subagent). Its production starting point is tagged `baseline-current`.

The [supervised Delegation spec](https://github.com/ZayRTun/Pi-Durable-Subagent/issues/1) and implementation tickets live in this repository. See the [local spec](specs/supervised-delegation.md), [issue tracker conventions](docs/agents/issue-tracker.md), [domain glossary](GLOSSARY.md), and [architecture decisions](docs/adr/).

## Try it without changing your setup

```sh
npm ci --prefix ~/.pi/agent/durable-subagent
pi --no-extensions -e ~/.pi/agent/durable-subagent/index.ts
```

`--no-extensions` disables discovered extensions; the explicit `-e` still loads this extension. This avoids conflicts with an existing `subagent` tool and tests operation without optional extensions. It also disables other discovered safeguards/tools: use a disposable repository for the initial smoke test.

Ask Pi to delegate a self-contained task to scout, researcher, reviewer, or worker. Do not run two extensions registering `subagent` or `/subagents` together.

For normal use, disable the existing subagent extension through `pi config`, and add this extension's `index.ts` path to your extensions setting. Leave other desired extensions enabled. Following explicit operator approval, this installation now has Durable enabled for a normal-use trial, with the installed pi-subagents extension disabled by its package resource filter. See [trial verification and rollback](benchmarks/ACCEPTANCE.md#approved-normal-use-trial). Start a fresh Pi session to use the new interface.

## Interface

New blocking delegation:

```js
subagent({ agent: "scout", task: "Inspect the authentication flow in src/auth. Return relevant paths and verification gaps; do not edit files." })
```

Explicitly resume unfinished work, or retrieve an already terminal result:

```js
subagent({ resume: "<32-character run ID>" })
```

Force a different model for one call, which is how a caller gets an independent second opinion:

```js
subagent({ agent: "reviewer", task: "Review the staged diff against the ticket.", model: "acme/reviewer-model" })
```

An unrecognized parameter is an error naming it, never an ignored key. A caller that asks for a capability this extension lacks learns that immediately, instead of receiving a successful run that quietly dropped the instruction. Supported batch and model-selection parameters are documented below. Unsupported parameters fail loudly; they never widen permissions or change the request silently.

- `/subagents` lists this Pi session's runs. Select one to view its result, request resume, or cancel interrupted work. View result renders a durable entry in the transcript and copies nothing into the parent's model context.
- Escape/cancellation during delegation aborts its current work. Completed edits/external effects are not undone.
- Closing Pi suspends work; reopening never automatically resumes it.
- Interactive resume requires confirmation. `/subagents` records a one-use approval before asking the parent to call the resume tool.
- Headless resume requires the operator-supplied `--subagent-resume <run ID>` flag, not merely a model assertion of permission.
- A succeeded or cancelled Run is terminal. Failed and interrupted Runs stay stopped until explicit recovery approval; paused Runs require a reassessment and a fresh allowance choice.
- A passing test suite from a Sub-agent proves its code and its own tests agree, nothing more. It resolves any ambiguity in the task silently and then encodes that choice in the tests it writes. State the acceptance criteria explicitly, including what happens on the failure path, or the run will pick an interpretation for you.

Durable delegation calls use Pi's self-rendered shell, with no background fill in any execution state. They sit on the normal chat background without changing user-message or other tool styling.

The collapsed view is two lines. The first carries the state icon, the agent name in its own color and bold, and the requested task in parentheses capped at 50 Unicode characters including the ellipsis, then clipped further to the terminal width. The second begins with `⎿` and names the state — Running, Pausing, Preparing handoff, Paused, Done, Failed, Cancelled, or Interrupted — then the model, thinking level, tool uses, tokens, cost, and elapsed time in parentheses. A single run has no header. Grouped output has a one-space outer inset across its heading, tree rows, separators, and expanded content; internal connector spacing is unchanged. Several steps are grouped under `Delegation · Ordered/Chain/Parallel · X/N done`, where done counts succeeded, failed, and cancelled runs only, and the cost is the sum of the children's recorded cost, not an added charge.

Metrics degrade by dropping tokens first, then the tool count, keeping model, thinking, cost, and elapsed time while they fit; model names may be shortened further, while numeric readings are omitted as whole items rather than cut halfway. Elapsed time reads `4m 19.1s`. Cost keeps the shared honest formatter, so a real but tiny spend never reads as free.

Expanded, each entry shows `Task`, then for a running run `Current tool` (from real call arguments, or `Waiting for model`) and at most three finished calls newest first, excluding the running call, or for a finished run its `Response` rendered as Pi Markdown. Multi-step calls keep the requested order, prefix each child with `├`/`└`, and show pending and Not run steps, so a partial group update never hides earlier completed workers. Only uncertainty or an interrupted run adds a compact warning; a missing tool list does not. Pi's native Ctrl+O still expands the whole row, and in fullscreen a click on a child header expands just that child. Agent color, duration, and usage all come from the record, so an expanded run after a restart reads the same as a live one. A TUI-only fast clock animates the running icon; it is owned by the delegation lifecycle, not by any component.

Pi's normal tool expansion shows current/recent activity only while running, then prioritizes the task and response. Routine extension metadata and full tool histories are omitted. Committed live usage is read from the replicated `pi.usage` ledger without polling SQLite on each animation frame. Blocking call usage is reported when the call finishes; detached execution spend is reported by the first relevant management result. Very large answers are truncated for display/model context; `/subagents` holds the full result, and the record file path is no longer shown in the row. Duration excludes time while closed, but a hard crash can lose unsaved duration from its last attempt. The in-memory activity log may also lose its latest updates; SQLite remains authoritative for recovery. The recorded tool-use count is tracked separately from the bounded activity log and reconstructed from durable history on recovery, so a busy or resumed run is not misreported as its last thirty calls. Cancelling an ordered batch or chain leaves unstarted steps marked Not run instead of starting new cancelled runs.

## Run States

Every delegation records its execution state:

- **Running** — working within its optional execution allowance.
- **Pausing** — allowance expired; the current tool retains workspace ownership while it finishes. New work tools are prohibited by the host, including calls already emitted in the same batch.
- **Preparing handoff** — work tools have drained; a final model turn runs with no tools and no separate handoff deadline.
- **Paused** — unfinished work and a handoff are retained, and workspace ownership is released. If the handoff failed, the retained record explains its limitation. Inspection and reopening leave it stopped; continuation requires an explicit reassessment and a fresh allowance choice.
- **Succeeded** — finished successfully.
- **Failed** — finished unsuccessfully from an execution/provider error. Historical timeout failures remain Failed.
- **Aborted** — deliberately cancelled; cancellation does not undo completed effects.
- **Interrupted** — the owning session closed or ownership was lost. Reopening leaves it stopped, and recovery requires explicit approval.

The persisted status for deliberate cancellation is `aborted`; the native row and parent-facing descriptions call it **Cancelled**. `Done` is the compact display label for a succeeded execution.

Handoff preparation uses up to three transient retries with exponential backoff and one corrective turn for empty text. Permanent errors stop immediately; exhausted or empty handoffs preserve Paused with a limitation and recorded usage. Pass `handoffRetryPolicy: "unlimited"` explicitly to remove the transient retry ceiling; cancellation and session shutdown still stop preparation. The policy may be set on a call or overridden per step. Handoff retries retain workspace ownership until safely paused.

For an allowance, a checkpoint is requested at 80% of the work period. The host closes tool admission at expiry; prompt instructions alone do not enforce this boundary. A stuck tool stays Pausing until it finishes or cancellation stops it. The expanded native row shows the complete task, current/retained activity, and handoff using the existing layout. A handoff is separate from the final task answer.

## Nonblocking supervision

Blocking remains the default. Set `nonblocking: true` to return an execution handle after admission while work continues in the owning Pi session:

```js
const { id } = subagent({ agent: "scout", task: "Map the login flow.", nonblocking: true })
subagent_status({ run: id })
subagent_wait({ run: id, waitSeconds: 30 })
subagent_steer({ run: id, guidance: "Include the callback path and relevant tests." })
subagent_cancel({ run: id })
```

`subagent_wait` defaults to 60 seconds and accepts 0–3600 seconds. A wait timeout returns the current state; it does not change the execution allowance, pause, or cancel the child. Cancellation stops pending work but does not undo completed side effects. The parent can continue reasoning and use other non-conflicting tools after a nonblocking start. The child retains workspace ownership while it works, is pausing, or prepares a handoff; a safely paused execution releases ownership. Parent writes to that workspace are blocked while ownership is held. Declared read-only host tools and session-native Tasks controls remain available; Tasks state stays in the parent session and is not bridged to the child. Unknown or effectful parent tools are blocked conservatively. Admission defaults to eight active executions per Pi session; set `PI_SUBAGENT_MAX_ACTIVE` to a positive integer to change the limit. At capacity, work is rejected without a hidden queue.

Use the same `nonblocking: true` option for `tasks` or `chain` to receive a group handle. Status, wait, and cancel accept either the group handle or an individual child handle. An allowance-paused dependency stays pending until that child continues and succeeds; parallel worktree siblings proceed independently. See [Several steps in one call](#several-steps-in-one-call) for the group behavior.

Continue allowance-paused work with a reassessment and a fresh allowance choice. Use `null` to remove the deadline:

```js
subagent({ resume: id, reassessment: "The API map is complete; inspect the tests next.", timeoutMinutes: 20 })
```

Interrupted and historical failed executions require explicit operator approval before recovery; cancellation is terminal. Continuing paused work, recovering a failed Run, recovering an interrupted handoff, or recovering interrupted work with unresolved unsafe tools starts a distinct execution attempt and preserves prior history. If interrupted work has only explicitly replay-safe retained submissions, the SDK may continue its existing submission without a new attempt. A tool call whose outcome was interrupted may have had external effects, so recovery reports that uncertainty and does not promise exactly-once side effects.

Steer active work with `subagent_steer({ run, guidance })`. Guidance is queued for a safe model or tool boundary and does not interrupt a running tool. Status distinguishes accepted guidance from guidance later inserted into the conversation; insertion does not establish that the model followed it. A completed execution accepts a separate follow-up instead:

```js
subagent_followup({ run: id, task: "Using the retained API map, identify missing auth tests." })
```

A follow-up receives a new execution handle and keeps the prior answer and usage history. Before reusing context, inspect `contextHealth` in status. If the estimate crosses the warning threshold, choose `reuse: true`; use `fresh: true` to start a new conversation. Agent, model, tools, and workspace remain fixed for retained reuse. Context size is an approximate committed-context estimate, not cumulative billed tokens or an exact next-request measurement; an unknown estimate stays unknown.

Automatic compaction is disabled. An idle completed or allowance-paused conversation can be compacted explicitly with `subagent_compact({ run: id })`. Its result reports **applied**, **no-op**, or **failed**, and keeps old answers retrievable. Compaction and context inspection do not promise restored reasoning quality.

Nonblocking work produces retained completion, failure, pause, concrete blocker, or stall notifications at parent boundaries. Sticky rows show relevant nonblocking work above the composer and disappear after final result delivery. Notification custom messages are informational; ordinary Pi host usage accounting is reported as newly accrued execution usage through management results and is deduplicated across retrieval. Full results remain available by execution handle.

## Agent definitions

Definitions are optional: by default the extension reads `<agent dir>/agents` and stands alone when that directory is absent. To add or replace directories, set a top-level `agentDirectories` array in `durable-subagents.json`. Relative paths resolve against the config file's directory and `~/` expands to the home directory. Precedence is a truthy `PI_SUBAGENT_AGENTS` path list, then `agentDirectories`, then the default. Original definitions are never modified. Override with a path list:

```sh
PI_SUBAGENT_AGENTS=/absolute/path/to/agents:/another/path pi -e /absolute/path/to/index.ts
```

Durable does not discover or require other extensions. Operators may explicitly configure directories supplied by any package. Earlier directories win, so an operator definition shadows a packaged one with the same name. A duplicate inside a single directory is still an error. `agentDirectories: []` deliberately loads no definitions. An unreadable or malformed config reports an error and loads no definitions rather than silently widening to the default.

YAML frontmatter:

- Required: `name`, `description`, explicit `tools` list (CSV or YAML array). A definition without a `tools` list is rejected rather than granted every tool, so a packaged definition that declares none is shadowed by an operator copy that declares one.
- Optional: `model` (`provider/model`), `thinking`, `timeoutMinutes` (optional, 1–480; omitted means no deadline), `color` (named badge color or six-digit hex).

Execution has no implicit deadline. The parent can pass `timeoutMinutes: N` (1–480 minutes) or `timeoutMinutes: null` to explicitly remove a deadline. Either choice overrides the Agent definition's optional default; omission uses that default, or no deadline when the Agent omits it. In `tasks` and `chain`, the call policy is a default and a step may override it, including with `null`. Existing requests remain blocking. This allowance limits child execution; it is separate from a supervision wait, which returns parent control without ending child work. No supervision wait parameter is exposed by the blocking interface.

- Model and thinking inherit independently from the parent when not declared. Every Sub-agent model request also receives its stable run ID as `sessionId`, including compaction, for provider routing/session affinity (required by OpenCode Go).
- Cost follows the effective thinking level. This is the largest lever available without changing the extension. Measured on real work in a Laravel repository, `low` cost 26% to 63% less than an inherited `high` for read-only reconnaissance and for ticket implementation, with correctness unchanged across six runs for each. For review, detection held at every level but the single under-graded finding came from `low`. Suggested starting policy: `low` for scout and worker, `medium` for reviewer and researcher. The extension does not choose for you. See [the evaluation](benchmarks/EVALUATION.md).
- Definitions/instructions are snapshotted for a run. Editing a definition affects new delegations, not an existing run's role.
- Nested delegation is opt-in through `allowSubagents: true` or an explicit `subagent` declaration and bounded to depth three. Ordinary caller tools never widen this capability.

Sub-agents start with a fresh conversation and the explicit task, not the parent's chat history. On both initial execution and resume, their instructions include the run's working directory, explain relative tool paths, and recommend reading named paths before doing narrowly scoped searches. Missing paths should be reported rather than triggering filesystem-wide discovery. This is guidance, not enforced filesystem isolation. They share the working directory; no sandbox or worktree is created. Loaded definitions record their canonical `definitionPath`. The prompt gives its containing directory as the anchor for definition-relative resource references, independently of the workspace used by ordinary tool paths. Older run snapshots without this field keep their existing guidance. This supplies location information, not permission to expand the task's scope. Repository instructions/skills are not automatically copied into the Sub-agent's prompt: include required context in the task, and the agent definitions instruct Sub-agents to inspect applicable repository guidance.

## Model selection

A call may name a model pool. The run records both the requested pool and the model it resolved to.

```js
subagent({ agent: "reviewer", task: "Review the diff.", role: "cross judges" })
subagent({ agent: "reviewer", task: "Review the diff.", model: "acme/second-opinion" })  // one exact model
subagent({ agent: "reviewer", task: "Review the diff.", model: "task:cross judges" })     // the same pool, other name
```

Pools live in `<agent dir>/durable-subagents.json`. Override the path with `PI_SUBAGENT_CONFIG`.

```json
{ "models": { "agents": { "poteto-agent": "acme/cheap" }, "pools": { "cross judges": ["acme/a", "acme/b"] } } }
```

Resolution order is the call's `model`, then its `role` pool, then `models.agents`, then the definition's `model`, then the parent model. A pool prefers an entry that differs from the caller's own model, because a second opinion only counts when the model differs. A pool that is not configured falls back and says so in the result, so a mistyped pool name is visible rather than silent. The config file is optional. Unknown model pools report their fallback. Malformed or unreadable configuration fails closed for definition-directory selection; stored-result retrieval and explicitly approved recovery do not require newly loaded definitions. Model updates preserve unrelated configuration fields.

## Poteto mode

Poteto's delegation interface is supported where it is additive, and rejected loudly where it is not yet built.

| Poteto shape | Status |
|---|---|
| `agent: "poteto-agent"` | works when its definition is explicitly supplied by the operator; no pstack dependency |
| ad-hoc helpers | works, any definition |
| `model` per call | works, for cross-family second opinions |
| `role` pools | works, see above |
| `tasks` | works as ordered steps; concurrent with worktree isolation |
| `chain` | works, sequential with each step handed the previous answer |
| `cloud_base_branch` | accepted as the checkout base |
| `model: inherit-parent` and `auto` | accepted, and resolve to the caller's model |
| `worktree` | opt-in, one git checkout per step |
| nesting to depth 3 | opt-in per definition, enforced by depth |
| `subagents_list` | provided |
| `subagents_write_task_models` | provided, for pools and pins |

Follow-up work uses a new Run in the retained conversation, preserving prior context while keeping its result and new usage separate. The parent can steer active work at safe boundaries, wait without stopping it, and inspect or cancel an ordered group. An interrupted Run stays stopped on reopen; recovery requires explicit operator approval. Paused continuation, failed-Run recovery, interrupted handoff recovery, and recovery with unresolved unsafe tools receive a distinct execution attempt. Explicitly replay-safe retained submissions may continue through the SDK's existing submission without a new attempt. Uncertain tool outcomes remain in the history for the model to assess, so approval does not guarantee that external side effects can be undone or that a model will obey every instruction.

Companion tools. `subagents_list` reports every loaded definition with its declared tools and declared model/thinking; the model a delegation actually runs on is resolved per delegation from the request, configured pins/pools, or the caller. `subagents_write_task_models` merges model pools and per-agent pins into the config file. `worktree_list` and `worktree_remove` manage the checkouts this extension created, and removal keeps the branch because it holds the work.

## Several steps in one call

```js
subagent({ agent: "scout", tasks: [{ task: "Map the auth flow." }, { task: "Map the billing flow." }] })
```

A call takes `task` for one step, or `tasks` for up to eight. Call-level `agent`, `role`, and `model` are defaults that a step may override. Each step is its own run, with its own record, status, and usage, and the reply labels every step in order.

`chain` takes the same step list but hands each step the previous step's answer, appended to its task. It runs in the caller's directory and refuses `worktree`, since isolation would hide one step's changes from the next.

For supervised groups, add `nonblocking: true` to `tasks` or `chain`. The start result returns a distinct group `id`, a child handle for every requested entry, and the requested-order presentation. `subagent_status`, `subagent_wait`, and `subagent_cancel` accept the group handle; a child handle targets that child. Unstarted dependencies can be inspected and cancelled without creating a Run: cancelled entries remain **Not run**.

An allowance pause holds later Ordered and Chain entries **Pending**. Reopening or inspecting the group does not start them. Continue the held child with `subagent({ resume: childId, reassessment: "<remaining-work assessment>", timeoutMinutes: null })` (or a fresh numeric allowance). Only its successful final answer advances dependents; its handoff never becomes a Chain answer. A failed or cancelled dependency leaves later entries Not run. Parallel siblings use separate checkouts and continue independently. Active capacity and workspace admission apply to each actual child; a capacity rejection is recorded and never retried through a hidden queue.

Only nonblocking groups appear above the editor, using the same one-space group inset, tree, metrics, Markdown, Ctrl+O, and per-child mouse expansion as transcript groups. Paused groups stay visible. Finished groups leave the sticky area after each child's completion notification is retained by the host. Blocking groups remain transcript-only. Group costs sum recorded child costs; management retrieval reports only newly accrued child usage.

## Nesting

A definition opts in by declaring `subagent` among its tools, or by the packaged `allowSubagents: true` spelling. Only then does a Sub-agent receive a delegation tool, and only while depth remains.

```yaml
tools: read, ls, ffgrep, bash, subagent
```

Nesting reaches depth three. A nested run is inside a tree the root already admitted, so it records and recovers like any other run without taking the workspace lock again. At the limit the deepest Sub-agent reports `subagent` as unavailable instead of failing late.

Delegation is never bridged from the caller's Pi tool list. The extension supplies its own depth-aware tool, so a definition cannot widen its own nesting by asking for a tool name that happens to exist.

Steps run one after another in the caller's directory. Add `worktree: true` and every step gets its own git checkout and they run concurrently.

```js
subagent({ agent: "worker", worktree: true, tasks: [{ task: "Fix A." }, { task: "Fix B." }] })
```

Concurrency is opt-in because isolation is what makes it safe. The tool allowlist cannot prove an agent will not write, since `bash` writes, and a convention is not concurrency control.

A checkout sits at the base commit and never contains uncommitted changes. That makes it right for parallel writers and wrong for reviewing work in progress, so leave `worktree` off when the steps must see the caller's working tree. A named `branch` applies to the first step and is suffixed for the rest. Checkouts are retained rather than removed. The reply names each branch and path so you can merge what you keep, then remove them with `git worktree remove`.

## Optional tools and permissions

The effective loadout is the definition's allowlist intersected with Pi's **currently callable** tools. This includes supported core tools and tools supplied by installed extensions. Tools hidden or model-only in Pi cannot be bridged.

Missing `fff`/web extensions do not prevent loading or delegation. Unavailable names are displayed and included in the Sub-agent's instructions. No imports or dependencies on those extensions exist. Missing tools are never replaced with broader permissions. A task genuinely requiring absent capabilities should return a verification gap rather than fabricate findings.

Pi tools are called through `ctx.executeTool()`, retaining argument validation, permission hooks, and nested-tool events. Bridged `codemode`, `tool_search`, and `subagent` are excluded because they could bypass the Sub-agent's explicit loadout. An Agent definition that lists `subagent` is rejected rather than silently narrowed, so recursion cannot be requested and quietly dropped. Extensions exposing their own unrestricted execution tools remain trusted code.

Core tools disabled in the parent are unavailable to Sub-agents too. For example, `ls` is off by default in Pi; activate it if desired. A Sub-agent is not guaranteed every built-in tool merely because it is installed.

All bridged tools are conservatively **unsafe to replay**. Even read tools can have hooks with side effects. After interruption, Durable reports their uncertain outcome to the model rather than automatically repeating them. The model may choose a subsequent action; resume is not a guarantee that side effects are exactly-once. `bash` in an allowlist is not enforced read-only access.

## Persistence and ownership

Default storage: `~/.pi/agent/sessions/durable-subagents/`. Override with `PI_SUBAGENT_STORAGE`. Relative overrides resolve against the host process's working directory, not a separate SDK session's workspace; absolute overrides are recommended. Displayed record-file paths are absolute.

Each run has a `run.json` record and its own `agent.sqlite` database. Durable owns the transcript, task checkpoints, submissions, and usage. The record snapshots identity/configuration and caches the terminal result for inexpensive retrieval. A stable submission request ID reuses work if the process dies between admission and result delivery. SQLite is authoritative for execution; the record may still say running after a hard crash.

One database/harness per run prevents explicit resume, submitting, waiting, or cancelling from waking other interrupted runs. Only a live Pi tool invocation supplies execution adapters; contexts are not reused after shutdown. The Pi SDK's generic nested-call records are scoped to the parent tool call and do not provide stable IDs for child calls that continue after a detached start returns. Durable's execution history and usage ledger remain authoritative; notification usage metadata is informational, while management results report newly accrued usage through Pi's standard accounting path.

Locks prevent two processes opening the same run, and prevent delegations sharing the same canonical working directory **when using the same storage root**. Locks heartbeat and expire 10 seconds after an unclean exit; immediate recovery may need a short retry. Different storage roots, unrelated processes, and manual edits are not coordinated. One delegation per working directory is deliberately conservative, even for agents described as read-only.

No daemon or remote runner is included. Chains, ordered batches, and explicitly requested parallel worktrees run in-process. The parent can also make successive delegation calls. Other Pi sessions working in different directories can execute independent delegations concurrently.

Records are retained until manually removed. Close all Pi processes using this storage before deleting old run directories. Removing records destroys their recovery/history. Stored prompts, outputs, paths, and tool transcripts may contain sensitive data. The extension does not copy provider credentials into metadata, but sensitive data returned by tools/providers or included in instructions may still be persisted. Storage directories are private and metadata files use mode 0600 where supported. The default location is covered by this repository's existing session-data ignore rule.

Cancellation/explicit execution deadlines are cooperative: a third-party tool that ignores abort signals can delay shutdown. An in-process extension cannot safely force-kill such a tool. Execution allowances apply per active work attempt, not wall-clock time while Pi is closed; expiry requests a safe pause rather than aborting the current tool.

## Verification

```sh
npm run typecheck
npm test
npm run test:workspace:stress
```

GitHub runs these checks automatically on pushes and pull requests. See [automatic checks](docs/agents/checks.md) for stress options and retained failure logs.

The full suite currently passes **213 tests**. Final combined acceptance evidence is recorded in [the supervised delegation acceptance report](benchmarks/supervised-delegation-acceptance.md). The report separates offline scripted-provider coverage, installed SDK and host behavior, native terminal evidence, and independent Tasks/pstack checks. Scripted provider results establish protocol behavior, not live model quality or obedience. The original 127-test count describes the historical baseline only.

The extension uses `createModels` from Pi AI's root export: Pi 1.0's unbundled loader aliases that root to its compatibility entrypoint, which does not correctly resolve arbitrary `/models` subpath imports. Host-provided Pi AI, coding-agent, and TUI packages are pinned peers with matching development dependencies; the extension does not declare them as runtime dependencies.

A live head-to-head against the installed `pi-subagents` 0.74.0, and an end-to-end run through the actual `pi` CLI (delegation plus zero-cost retrieval and repository-integrity checks), are written up in [the follow-up evaluation](benchmarks/EVALUATION.md). Both engines answered every benchmark task correctly; Durable used about half the tokens and estimated cost in that fixture, while latency was effectively tied except on the largest task. Those comparisons are historical; this installation now uses Durable.

Reproduce the live checks (these make real, potentially billable model calls):

```sh
node --experimental-strip-types agent/durable-subagent/benchmarks/compare.mjs
node agent/durable-subagent/benchmarks/cli-live.mjs
node --experimental-strip-types agent/durable-subagent/benchmarks/smoke.mjs
```

The CLI loader was smoke-tested with `pi --no-extensions -e .../index.ts --help`. A live read-only CLI delegation using `opencode-go/deepseek-v4.1-flash` was verified with only this extension loaded: scout succeeded using `read` and `bash` while `ls`, `fffind`, and `ffgrep` were unavailable. A follow-up high-thinking comparison using normal SDK file loading for both extensions passed all 20 live delegations, including two relative-path tasks without workspace hints in the task and two five-file inspections in a 34-file fixture per extension. See `benchmarks/REPORT-HIGH.md` and the retained measurements. An offline real-CLI PTY flow also passes expansion, menus, result viewing, confirmation, Escape cancellation, paused reopening, approved resume without repeated fixture effects, and resizing to 50 columns. This is automated interaction and text inspection, not human visual sign-off. See [acceptance evidence and manual-check instructions](benchmarks/ACCEPTANCE.md). The user has now reported completing the manual fixture cases without reported defects. A subsequent isolated real-model scout smoke also passed named-file reading, correct execution tracing, honest capability gaps, and unchanged fixture hashes; its evidence and potentially billable reproduction command are in the acceptance report. No independent pixel-level validation is claimed. The default resource switch was subsequently made only after separate operator approval, with a rollback copy retained. Pi Durable's API and Node's SQLite support are experimental; Pi dependencies are pinned to 1.0.0.

### Dependency audit caveat

`npm audit` currently reports a high-severity `brace-expansion` advisory inherited from Pi coding-agent 1.0.0's bundled/shrinkwrapped dependency tree (`brace-expansion` 5.0.9). A local npm override did not replace the bundled copy and was removed rather than presenting a false fix. Track an upstream Pi release with a patched bundle. The extension does not itself use brace expansion, but the dependency warning remains relevant.
