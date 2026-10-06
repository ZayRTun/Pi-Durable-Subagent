# Supervised Delegation acceptance

Acceptance evidence for spec #1, collected 2026-10-06. All provider calls in this gate used the installed Pi host with an offline scripted provider; no paid model calls, package publication, push, release, or active-installation migration occurred.

## Combined host and session behavior

[`test/pi-combined-acceptance.test.ts`](../test/pi-combined-acceptance.test.ts) runs two end-to-end scenarios through the installed Pi `createAgentSession` and the public Durable tools. The first holds a host adapter open after a workspace effect, lets the parent complete a separate reasoning turn, performs a non-blocking Chain start and bounded wait, rejects competing workspace/capacity work, accepts steering, expires an allowance while an admitted tool finishes, retries a transient handoff failure, and leaves the dependent child Pending. It then reopens the owner session, verifies no automatic group progress, continues with an explicit reassessment and no deadline, inspects context health, explicitly compacts, and creates a retained-context follow-up.

Across that path the controlled workspace effect runs once. The Chain receives the successful prior answer, not the handoff. Management retrieval for historical Runs reports no new usage; follow-up usage equals only its provider calls, including compaction spend in the retained conversation ledger exactly once. Three independent execution identities each receive one retained success notification. The immediate child-wait assertion covers the admission-to-group-persistence window and verifies that a started child is shown as Running rather than Pending.

The second scenario completes a workspace effect and interrupts a later host tool while its owning session closes. Reopen leaves the Run stopped. An unapproved resume is rejected before any adapter call. Approved recovery preserves the original task and uncertain tool outcome, retires the old unanswered unsafe submission, starts a separately identified recovery attempt, and uses current host permission hooks. A retained follow-up also uses the current permission adapter. The old workspace effect is never repeated, historical usage is not billed again, and cancelling a held child remains terminal after another reopen and retrieval.

When an interrupted execution has an unanswered tool explicitly marked safe to replay, recovery keeps the retained SDK submission and its safe continuation behavior. An interrupted unsafe tool or an interruption during tool-free handoff preparation instead retires the old submission and starts a distinct approved attempt. `test/handoff-retry.test.ts` verifies successful work followed by shutdown during handoff retry, then checks that approved recovery returns a fresh answer without repeating the work.

Targeted regression checks passed: `test/handoff-retry.test.ts`, `test/pi-combined-acceptance.test.ts`, `test/runtime.test.ts`, and `test/pi-recovery.test.ts` passed 26/26 together. These host tests use an offline faux provider and assert provider-ledger totals independently of Durable's reported usage.

## Native terminal behavior

The real Pi 1.0.4 CLI PTY gate covered ten scenarios (`single`, `ordered`, `chain`, `parallel`, supervised running, pause and completion, plus ordered, Chain, and parallel group pause) at 80 and 120 columns, both themes, and regular and fullscreen modes. All 80 final probes and all 80 geometry checks passed. The checks include header hit areas and persistent expansion, spinner stop after sticky removal, full-row background behavior, exact group and single-run indentation, expanded Markdown continuation columns, retained paused work, completed-work removal, and composer spacing compared with the host's idle baseline. Aggregated exact-geometry counts were 136 group headings, 576 agent headers, 576 metric rows, 664 body labels, 824 expanded-content lines, 164 Markdown continuation lines, 7,604 background rows, and 48 composer-baseline checks.

The probe first passed 70/80; evidence-directed corrections exposed four observer timing/visibility issues and one expected transcript-scroll variation. The final reruns passed all missing cases without source or design changes. This is terminal text and geometry evidence, not a pixel-level or human visual sign-off. The gate ran against native-render source commit `4e5a761897085935ca0448aad395703e49da8c2b`; ticket12 changes after that point affect host status/recovery behavior and do not edit the renderer. The final candidate also receives a targeted CLI recovery smoke after its commit.

Raw native evidence is retained outside the repository at `/tmp/pi-spec-1/native-matrix/`; the compact result files are committed alongside this report in [`benchmarks/evidence/spec-1/native`](evidence/spec-1/native/). Reproduce with `python3 /tmp/pi-spec-1/native-matrix/run.py` and `python3 /tmp/pi-spec-1/native-matrix/geometry.py` while that local probe workspace is available. First-pass and observer-correction logs remain beside the final summary.

## Independent package checks

Using Pi SDK 1.0.4 and offline providers, Tasks passed 45/45 tests and typecheck; pstack passed 105/105 tests and typecheck. The installed-host matrices also passed pstack-alone, Durable-alone, Tasks-alone, optional Durable+pstack composition, and all-three composition. Reload retained Tasks state, each package registered only its own tools, Durable children did not receive the Tasks tool, and Durable did not mutate Tasks state. No provider calls were paid. The accepted matrix, source manifest, and test logs are in [`benchmarks/evidence/spec-1/packages`](evidence/spec-1/packages/).

## Limits and reproduction

The host's offline provider proves the submission, permission, accounting, and lifecycle paths exercised by these fixtures; it does not measure live-model task quality or establish guaranteed obedience. Tool side effects can be uncertain after an interruption, and an approval cannot undo an external effect. Unsafe interrupted calls are not blindly replayed; explicitly safe calls retain the SDK's safe continuation path. Context estimates are approximate, and applying compaction does not prove that reasoning quality is preserved.

The installed SDK scopes generic nested-call records to the parent call that created them. Later detached calls therefore do not use that transient record as their durable identity or billing source. Durable keeps per-Run activity and usage records and uses retained execution-scoped notification receipts. For host usage reporting, newly accrued management usage is exposed once as a delta on the first relevant tool result; repeated retrieval reports no new usage.

Run the complete project regression gate from the repository root:

```sh
npm test
npm run typecheck
```

The final outputs are retained in [`benchmarks/evidence/spec-1/durable`](evidence/spec-1/durable/).

The native PTY matrix and independent package checks use disposable fixtures and the artifacts linked above; they do not change the installed extension or its configuration.
