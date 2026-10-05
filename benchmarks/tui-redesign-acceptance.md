# Native TUI redesign acceptance

The approved design is implemented in `ui.ts`, with additive presentation metadata in `presentation.ts` and `index.ts`. Runtime changes supply bounded argument labels, a cumulative tool-call count reconstructed on recovery, and committed live model usage. Existing persisted Run States, permission checks, explicit recovery approval, and final usage reporting remain intact.

## Verified

- Durable typecheck and 121/121 tests pass.
- Tasks typecheck and 45/45 tests pass.
- Pstack-alone, Durable-alone, and optional-composition SDK checks pass.
- Native Pi 1.0.2 PTY checks cover single, Ordered, Chain, Parallel, failure, cancellation, and cancelled Chain states at 80/120 columns, dark/light themes, and regular/fullscreen modes.
- Running Agent-header spinner frames advance. Fullscreen child-header clicks expand only that child. Native Ctrl+O expands the whole tool and preserves expansion across progress updates.
- Expanded running output shows a real current tool and up to three finished calls. Completed output retains original Markdown headings and list continuation indentation, without tool history or routine extension metadata.
- Cancellation stops unstarted ordered/chain steps and displays Not run. Ordinary returned failures still follow existing scheduling behavior.
- Tool counters exceed the thirty-call activity window correctly and do not recount an interrupted tool after recovery.
- Committed live usage comes from `pi.usage.models`; partial presentation updates do not add billed usage.

## Truncation background defect

An offline fixture using native `TruncatedText` reproduced default-background patches at the truncation marker inside Pi's actual tool-result background. The native truncator emits full SGR resets around the marker. Durable's replacement clips by visible columns without injecting that background-clearing reset.

The native PTY observer captures ANSI background state for each terminal cell. New Agent headings retain the same non-default background at the ellipsis as the adjacent text, including repeated narrow/wide resizing. The observation is a terminal-cell check, not a human screenshot comparison. The initial probe had an observer bug that cleared its virtual screen even when width was unchanged; correcting that observation made the 120-column checks pass without a production change.

## Recovery surface

The actual CLI was killed during a controlled fixture tool, reopened, and inspected without model execution. `/subagents` View result and explicit resume confirmation passed. Approved recovery did not repeat the fixture side effect. The new uncertainty warning, final response, cleared interrupted footer, and 50-column resize were verified.

## Review

Two independent read-only candidate reviews were performed. Findings were corrected, including immutable partial presentation entries, displayed original chain tasks, preserved response headings, bounded activity rows, animation callback lifetime, parallel settlement before heartbeat disposal, generic-error preview bounds, and suppression of recognized credential-bearing command summaries. Command labels are a conservative presentation projection, not a general-purpose secret-redaction guarantee. Raw task/tool data can still contain sensitive input, as documented for storage.

## Evidence and reproduction

Evidence directory: `/tmp/durable-tui-implementation-mn5gtM/`. It contains source preservation snapshots, candidate reviews' fixed-point source snapshots, full-suite logs, native scenario logs and fixture-directory pointers, recovery logs, and optional-composition evidence. Each disposable native fixture retains plain viewports, raw ANSI, background comparisons, and acceptance metadata.

```sh
npm run typecheck --prefix agent/durable-subagent
npm test --prefix agent/durable-subagent
D=$(mktemp -d /tmp/durable-tui-manual-XXXXXX)
/opt/homebrew/bin/python3 agent/durable-subagent/test/fixtures/tui-redesign-probe.py \
  "$D" "$PWD/agent/durable-subagent" --scenario chain --width 80 --theme dark
```

The fixture uses a scripted provider, real disposable file reads, and a synthetic waiting tool. Acceptance checks make zero paid provider calls. Parallel acceptance initializes and commits a disposable test repository only; no project commit, push, publication, operator-config edit, or unrelated repository modification was made. The browser/Python prototype remains a design reference and is not the production renderer.

Reload Pi before using the redesigned extension in an already-running session. Fullscreen supports individual mouse expansion; regular mode uses native whole-tool Ctrl+O. Usage readings show committed spend so far, not invented estimates of an unfinished model stream.
