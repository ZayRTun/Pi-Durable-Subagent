# Crash recovery and terminal acceptance follow-up

## Status

- **Typecheck passed; 35 tests passed**, with no failures or skips.
- Actual Pi CLI SIGKILL/reopen/operator-approved recovery passed.
- Actual Pi CLI terminal interaction through a PTY passed, at 100 and 50 columns.
- Crash/PTY acceptance responses used the local scripted `acceptance-local/faux-1` provider, with **no paid model requests**. Its displayed token/cache usage is synthetic, not a performance measurement. A separately approved real-model follow-up is documented below.
- Acceptance checks did not change active configuration or original definitions. After separate operator approval, the normal-use trial was enabled as documented below. No commits were made.
- The user reports completing the manual fixture cases, with no defects reported. This is user-reported manual acceptance, not independent pixel/color validation. The PTY helper approximates a plain viewport; it is not a complete terminal emulator and cannot assess colors, fonts, grapheme rendering, or subjective usability.

Test environment: macOS, Node 22.22.2, Pi CLI/SDK 1.0.0. Dependencies remain pinned. These checks do not remove the documented experimental API/SQLite and upstream dependency-audit caveats.

## Hard-kill recovery

`test/pi-cli-kill.test.ts` launches the actual Pi executable in disposable sessions with explicitly loaded extensions and an offline provider. Its unsafe `hold` tool appends one line to a fixture file, reports readiness, then waits. The test verifies the reported PID matches the process it launched before sending SIGKILL to that exact process.

Verified sequence:

1. The process dies without orderly shutdown; the cached record still says `running`.
2. A fresh process lists the run as interrupted, without any Sub-agent model call.
3. Resume without the operator flag is rejected, without any Sub-agent model call.
4. An approved attempt during the existing lease fails with `Lock file is already being held`; the record is unchanged. This branch was exercised in the retained run. The test skips this early probe if startup has already consumed its safe timing window.
5. After real lease expiration, a fresh process resumes with `--subagent-resume <run ID>`. No lock is deleted and no timestamp is manipulated.
6. Recovery uses the original snapshotted role and workspace even though the fixture's definition has changed.
7. The interrupted unsafe tool is not replayed. Its structured diagnostic and visible activity log retain the uncertainty marker.
8. The fixture file is exactly `effect\n`: one external effect across the initial attempt and recovery.
9. Retrieving the completed result makes no additional Sub-agent model call.

This proves the tested recovery path and prevention of automatic unsafe replay. It does **not** prove general exactly-once side effects: a resumed real model may choose a subsequent action, and external effects are not transactions or rolled back by cancellation.

Retained raw evidence (temporary directories can be cleaned by the OS):

- CLI: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/durable-cli-kill-3RDmDG/`
- Full-suite output: `/tmp/durable-final-tests.txt`

## Terminal checks and fixes

`test/fixtures/terminal-probe.py --live` drives a real, fullscreen Pi CLI through a standard-library PTY. It uses a fresh disposable profile and records raw ANSI plus approximate text viewports.

| Check | Observed result |
|---|---|
| Successful answer with a missing optional capability | `succeeded`, answer, and `1 unavailable` remain visible |
| Synthetic provider failure | `failed` and the actual `fixture-provider-error` text remain visible |
| Blocked tool | `running` with `Using hold`, not a stale model-wait label |
| Escape cancellation | `aborted`, distinct from provider failure or interrupted work |
| SIGKILL and reopen | Interrupted count remains in Pi's footer; no Sub-agent request before approval |
| Ctrl+O | Expanded task, model, workspace, capability gaps, record path, and activity |
| `/subagents` | Run list, action menu, and result viewing work |
| Resume action | Explicit confirmation warns about uncertain effects and unsafe replay |
| Confirmed recovery | `succeeded` with `uncertain outcome`; activity says `outcome uncertain` |
| Fixture effect after resume | Unchanged from before approval |
| Pending-work footer after resume | Cleared, rather than left stale |
| Resize to 50 columns | Delegation status and expanded content wrap within the narrower viewport |

The Cancel action is present in the menu. **Executing that stored-run Cancel action was not driven by this PTY flow**; stored cancellation is covered by runtime tests, and live Escape cancellation is exercised here.

The checks exposed real defects as well as fixture setup errors:

- The CLI fixture originally omitted `hold` from the parent allowlist. The fixture was corrected, not the production permission boundary.
- Durable settles an interrupted unsafe tool with a result entry containing an `interrupted` diagnostic. Checking only for a missing entry hid uncertainty. The activity reconciler now uses structured diagnostics, not arbitrary tool-output text.
- A 150 ms progress throttle could drop the final activity update in a fast burst and leave a blocked tool labelled `Waiting for model`. A fast regression failed before the fix. Activity transitions now publish immediately, and a run-scoped display-only timer refreshes duration once per second. It is cleared when the attempt ends and does not keep the process alive by itself.
- The transient startup notification could disappear behind restored history. A native footer status now retains the interrupted count until resume/cancellation.
- Terminal activity is reconciled with final result diagnostics so cancelled calls do not remain labelled as running.
- Generic tool-error details are not run records. A normal-loader renderer regression now ensures these errors display their message rather than throwing while accessing a missing record ID.
- Expanded output includes the absolute record path, including when the displayed answer is truncated.

Retained raw terminal evidence: `/tmp/durable-ui-CFqWpB/`. Selected plain viewports are copied into [acceptance-ui/](acceptance-ui/). The paths and run IDs in those captures belong to disposable fixtures. The raw ANSI is retained only in the temporary directory; plain captures are not pixel/color screenshots.

## Reproduce automated checks

From the repository root:

```sh
npm run typecheck --prefix agent/durable-subagent
PI_KEEP_ACCEPTANCE_ARTIFACTS=1 npm test --prefix agent/durable-subagent

EXTENSION="$PWD/agent/durable-subagent"
DIR=$(mktemp -d /tmp/durable-ui-XXXXXX)
python3 "$EXTENSION/test/fixtures/terminal-probe.py" "$DIR" "$EXTENSION" --live
```

The `--manual` launcher was also smoke-tested through an outer PTY: actual TUI startup, no model calls before input, and clean Ctrl+D exit passed. This validates the launcher, not human visual acceptance.

The Python helper requires a working Unix Python interpreter, PTY support, and `pi` on PATH. On the tested machine, the default `python3` points to an incompatible binary; `/opt/homebrew/bin/python3` was used instead. The CLI test also accepts `PI_ACCEPTANCE_CLI=/absolute/path/to/pi`.

The automated terminal probe kills only the Pi process it launches, then waits for the real crash lease. It preserves fixture evidence. Do not use these disposable-profile commands as a way to disable safeguards in a real project.

## Human visual check, without changing active configuration

Use a new fixture directory, or reopen the directory printed by a completed automated terminal probe to inspect its recovered result:

```sh
EXTENSION="$PWD/agent/durable-subagent"
DIR=$(mktemp -d /tmp/durable-ui-XXXXXX)
python3 "$EXTENSION/test/fixtures/terminal-probe.py" "$DIR" "$EXTENSION" --manual
```

Replace `python3` with a working interpreter if necessary. Keep `DIR` to reopen the same isolated session later with the same command. The helper requires a `durable-ui-*` directory and loads only Durable plus the synthetic fixture. It isolates configuration, sessions, and storage; it does **not** create an OS sandbox.

In that Pi terminal:

1. Enter `ui success`. Check agent color, readable state text, answer preview, and the missing-capability badge.
2. Press Ctrl+O. Check task, model, paths, capability name, and record path. Toggle back and confirm the compact view remains useful.
3. Enter `ui failure`. Check that failure text is readable and distinct from success or cancellation.
4. Enter `ui hold`. Wait a few seconds: check `Using hold` and an advancing elapsed time. Press Escape and check `aborted`. The fixture's already-recorded effect is not undone.
5. Use `/subagents`, choose a run, then View result. Check keyboard navigation and Escape cancellation of menus.
6. Resize to roughly 50 columns, then restore the width. Check wrapping, focus, legibility, and clipping; also try a light theme if that is part of normal use.
7. To inspect recovered uncertainty, run the automated flow in another fresh directory, then reopen that same directory with `--manual`. View its recovered run and confirm the uncertainty marker is conspicuous.

Do not infer live model quality, billing, or real workload performance from these scripted answers. Do not terminate unrelated Pi processes to test recovery. Stored-run Cancel-menu confirmation, typography/colors in the user's terminal, and practical usability remain human acceptance items.

## Approved normal-use trial

Following separate operator approval, `agent/settings.json` now loads `durable-subagent/index.ts`. The existing `npm:pi-subagents` package entry uses object form with `extensions: []`, disabling its extension without uninstalling it or deleting its records. Web access, fff, other enabled extensions, model/thinking defaults, theme, tool selection, and unrelated preferences are preserved. Old package skills/resources were not removed; instructions for its workflows/council APIs are not compatible with Durable's minimal tool.

Rollback copy (private session-data directory):

`/Users/zayar/.pi/agent/sessions/config-backups/settings-before-durable-2026-10-02T09-58-48-965Z.json`

Verification after the change:

- `pi --offline --help` exits successfully and lists Durable's `--subagent-resume` flag.
- Normal resource loading finds exactly one owner of `subagent`: `/Users/zayar/.pi/agent/durable-subagent/index.ts`.
- No installed pi-subagents extension is loaded; web access, fff, and the other currently enabled personal extensions load without extension errors.
- JSON comparison against the rollback copy confirms only the package filter and appended Durable extension path changed.
- No model requests were needed for these load checks.

Open a **fresh Pi session** for the trial, rather than relying on this conversation's old tool definitions. Project-local settings can override package/resource selection; do not enable both implementations in the same project. To roll back without overwriting later preference changes, remove the Durable extension entry and restore the old package's extension selection. The full backup can restore the exact pre-trial settings if no later changes need preserving.

## Real-model follow-up

After the user completed the manual fixture and approved the next step, `benchmarks/smoke.mjs` ran one actual `opencode-go/deepseek-v4.1-flash` scout delegation at high thinking. The parent was scripted locally; only the Sub-agent made live model requests. Normal SDK file loading was used with no ambient extensions or skills.

The five-file disposable repository contains README.md, package.json, and three source files. The scout definition is copied from the user's original backup into the isolated agent directory, with an explicit live model and one-minute timeout; the original is unchanged. This is prompt-guided read-only work, not filesystem isolation.

Verified result:

- Completed in **10.570 seconds**; run ID `2f1c6e453892646697b73004257d630b`.
- Read README.md and package.json first, followed by src/index.ts, src/settings.ts, and src/pricing.ts.
- Correct entry point and execution order: `main → settings → quote`.
- Correct concern: shipping was calculated before discount; actual total 48, specification-correct total 53.
- Reported missing tests and unavailable `ls`, `fffind`, and `ffgrep`.
- Used two bounded read-only listings (`find src ...`, `find . -maxdepth 3 ...`), not filesystem-wide discovery. This was not a pure direct-read-only trace.
- Workspace tree/content hashes match before and after; original scout definition is unchanged.
- Reported usage: 2,445 uncached input, 6,656 cached input, 944 output tokens; model-rate estimated cost **$0.000953**, not a subscription invoice.

Sanitized evidence: [smoke-result.json](smoke-result.json). Raw evidence: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/durable-real-smoke-4DnPwE/` (temporary).

To repeat this **live, potentially billable** test:

```sh
node --experimental-strip-types agent/durable-subagent/benchmarks/smoke.mjs
```

It defaults to the model/thinking above. `SMOKE_MODEL=provider/model` and `SMOKE_THINKING=high` can override them. It uses configured provider credentials without printing them. This is one correctness/scope smoke test, not a latency comparison or a production-scale reliability guarantee; it is intentionally not part of the offline `npm test` suite.

## Follow-up round: operator evaluation fixes

A real-workload evaluation (scout, researcher, reviewer, worker, retrieval, and an intentional concurrent attempt) confirmed the durability loop and surfaced defects. Disposition of each finding:

| Finding | Outcome |
|---|---|
| Terminal retrieval rewrote `run.json` (`updatedAt` changed) | **Fixed.** A terminal run now returns before execution admission, so no lock and no save occur. Regression asserts byte-identical records for `succeeded`, `failed`, and `aborted`. |
| The one-delegation-per-directory guard blocked retrieval | **Fixed.** The cached read happens before the workspace guard; retrieval now succeeds while another delegation is active. Regression covers it. |
| `interrupted` was an undeclared fifth Run State | **Reconciled.** `CONTEXT.md` now enumerates all five Run States, including Interrupted, and Failed covers a declared time-budget overrun. The extension follows that vocabulary. |
| Recursion rejection weaker than documented | **Fixed.** An Agent definition listing `subagent` is rejected, not silently narrowed. |
| Unvalidated `color`, model syntax, and fragile default agents directory | **Fixed.** Colors and model parts are validated; a missing definitions directory reports through the existing errors channel instead of aborting extension load. Namespaced model IDs such as `openrouter/anthropic/...` remain valid. |
| Timeout recorded as `failed` despite the old Failed definition | **Reconciled** by broadening Failed to include exceeding the declared time budget; `failed` remains the recorded state and the error text still says `Timed out after N minutes`. |
| `/subagents` → View result injected the full answer into model context | **Fixed.** View result now appends a durable session entry rendered by an entry renderer. Entries are excluded from model context, so a stored answer can no longer consume parent tokens. |
| Vocabulary drift: "child" for the Sub-agent concept | **Fixed** in code, prompts, and current documentation. "Child process" is retained only where it means the OS mechanism. |
| Cost skew from inherited `high` thinking | **Documented, not changed.** Declaring `thinking`/`timeoutMinutes` per Agent definition is the operator's call; the extension does not choose for them. |

Two further defects were found while re-reading the admission path rather than reported by the evaluation:

| Finding | Outcome |
|---|---|
| A delegation that lost the cross-process workspace lock could leave an orphan `run.json`, which later appeared as interrupted work to resume | **Fixed.** A record is now written only after the workspace lock is granted, and an unadmitted run removes its empty directory. Regression asserts the contender reads `ENOENT` and the interrupted list stays empty. Verified red against the previous code, green after. |
| `/subagents` showed a running delegation's stale start record because only disk state was read | **Fixed.** A running delegation reports its latest in-memory snapshot to inspection; returned copies cannot mutate it. |
| Cancelling a just-crashed run surfaced a raw lock error and did nothing | **Improved.** The handler now explains that the lease is still held and to retry shortly, instead of failing with an opaque error. |

Uncertainty reporting also gained a second source: Durable's own tool-slot diagnostics (`interrupted`, `aborted`) are used directly, in addition to the recovered-entry reconciliation, without inferring state from tool text.

Post-fix verification: typecheck passed; **44 tests passed**; the real SIGKILL/reopen/approved-recovery test and the offline actual-CLI PTY flow (including the new display-only View result) both passed. No paid model requests were made for this round.

Fresh PTY artifacts: `/tmp/durable-ui-h9iGvN/`. Full-suite output: `/tmp/durable-followup2.txt`.

## Limits and decision

The extension remains a minimal blocking, in-process design: no automatic resume, daemon, orchestration engine, recursive delegation, worktree manager, or OS permission isolation. Display refresh is not background execution of delegated work. Tools that ignore cooperative abort can still delay shutdown. A hard crash can lose the latest unsaved metadata/log updates and active duration; SQLite checkpoints govern recovery.

The earlier high-thinking comparison still shows effectively tied latency and a token difference largely attributable to cheap cached input. No comparative paid benchmark was rerun after these UI changes. The single real-model smoke above adds correctness/scope evidence, not a new speed or cost advantage.

The crash and automated terminal gates are satisfied for the tested paths. The user reports completing manual fixture checks, and the isolated real-model smoke passed. Stored-run Cancel-menu execution remains runtime-tested rather than PTY-driven, and no independent pixel-level review is claimed. The operator subsequently approved the normal-use trial. Only the global resource-selection changes below were made; original agent definitions are unchanged.
