# Follow-up: fixes and high-thinking comparison

This follows the historical pre-fix low-thinking comparison in `REPORT.md`. Active user configuration and original agent definitions were not changed.

## Fixes and regression evidence

1. **Workspace context:** the original runtime stored `cwd` but omitted it from the model's instructions. `prompt.ts` now constructs one instruction string for both creation and resume: quoted workspace, relative-path semantics, named-path-first reads, narrow discovery, and honest missing-path reports. It explicitly says this is not a filesystem sandbox. The role remains snapshotted; tool availability refreshes on resume.
2. **Normal SDK loading:** Pi 1.0's unbundled loader maps the Pi AI root to `compat.js`; its prefix alias also catches `/models` and tries `compat.js/models`. `adapters.ts` and `runtime.ts` now use the supported `createModels` root export. No SDK patches, absolute dependency paths, dynamic-loading hacks, or inline-loader workaround are needed.
3. **Packaging:** host-provided Pi AI/coding-agent/TUI libraries are pinned peers plus development dependencies rather than direct runtime dependencies, following Pi's package contract. Lock metadata was refreshed offline without changing the host installation.

The four SDK integration variants (inline/file loading × optional tools present/absent) failed before the fixes and passed afterwards. The tests assert workspace/scoping information reaches the Sub-agent when the task only gives a relative path, then exercise actual nested tools and Pi permission hooks. A new SDK recovery regression shuts down a live delegation, reopens the same persisted run, rejects unapproved headless resume, explicitly approves it through the operator flag, and verifies frozen role/workspace and no replay of the interrupted unsafe tool. This is orderly SDK shutdown/reopen, not a hard-kill CLI test.

Verification at benchmark time: typecheck passes; **27 tests pass**; regular Pi CLI loading with `--no-extensions -e .../index.ts --help` passes.

## Live comparison protocol

- Installed `pi-subagents` **0.74.0** vs current local Durable implementation.
- Live model: **`opencode-go/deepseek-v4.1-flash`**.
- Requested and recorded thinking level: **high** for both extensions.
- Same read-only role and declared `read`/`bash` allowlists; fresh foreground conversations.
- Scripted local parent, no parent-model network calls.
- Fresh Node process per trial; normal SDK file loading for **both** extensions.
- Alternating execution order; two repetitions per task per extension; 60-second Sub-agent deadlines.
- Five cases: release extraction, pricing review, import tracing, the original relative-path task without workspace instructions in the task, and a five-file order-processing inspection in a disposable 34-file fixture.
- Exact JSON value/structure scoring, ignoring object-key order.

The fixture remains small and synthetic: 24 files are irrelevant modules, not 24 additional files that each task must inspect. This is broader than the initial tiny fixture, not a production-scale codebase benchmark.

## Results

| Metric | Installed | Durable |
|---|---:|---:|
| Correct answers | 10/10 | 10/10 |
| Failed/timed-out delegations | 0 | 0 |
| Mean delegation time | 5.961 s | 5.981 s |
| Median delegation time | 5.136 s | 5.370 s |
| Total tokens, including cached input | 42,221 | 28,979 |
| Model turns | 25 | 25 |
| Tool calls | 24 | 23 |
| Model-rate cost estimate, ten runs | $0.002865 | $0.002734 |

Average latency is effectively tied: Durable was 0.3% slower in this sample. Its median was 4.5% slower. **The earlier 18% latency improvement is not supported by this follow-up.** Total token consumption was **31.4% lower** for Durable, but cost estimates were only 4.6% lower because provider cache usage differed. These estimates are not subscription invoices.

| Task | Installed mean | Durable mean |
|---|---:|---:|
| Release extraction, scoped | 4.46 s | 5.55 s |
| Pricing review | 5.61 s | 5.67 s |
| Import tracing | 5.35 s | 4.87 s |
| Relative path, no workspace in task | 4.80 s | 5.00 s |
| Larger five-file inspection | 9.58 s | 8.80 s |

Both previously problematic relative-path trials now succeeded for Durable, in 4.70 and 5.30 seconds. Both read `release.md` directly; no broad discovery occurred. Durable's other task calls stayed inside the fixture: file reads and one additional `pwd && ls` after reading the scoped release file. Installed used bounded fixture-relative discovery in some trials. Neither engine was modified mid-benchmark.

## Assessment

The workspace and loader defects are now regression-covered and the live failure did not recur in the two follow-up relative-path trials. That demonstrates progress, not a statistical guarantee against future model misbehavior. Shell access still grants normal OS permissions; prompts do not enforce scope or read-only access.

Durable remains a promising narrower alternative with lower token overhead. At high thinking, do not claim it is generally faster or dramatically cheaper. The installed extension remains the broader orchestration tool. No configuration switch is recommended solely on these measurements.

At benchmark time, manual terminal UI acceptance and actual hard-kill/reopen/operator-approved recovery were pending. The subsequent [acceptance follow-up](ACCEPTANCE.md) passes the real SIGKILL recovery gate, an offline actual-CLI PTY flow, and a 35-test suite. User-reported manual fixture checks and a subsequent real-model scout smoke are recorded there; no independent pixel-level review is claimed, and automated interaction does not substitute for human judgment. These later UI changes have not been rebenchmarked, and the measurements in this report remain evidence for the benchmarked revision.

## Evidence and reproduction

- Retained sanitized trial records: `measurements-high.json`.
- Raw artifacts: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/pi-subagent-comparison-3Rr8z1/` (OS may clean these).
- Run: `node --experimental-strip-types agent/durable-subagent/benchmarks/compare.mjs`.
- Set `BENCH_THINKING=low` to use low thinking on the **current** implementation and expanded case set; that does not reproduce the old pre-fix implementation.
- `BENCH_SMOKE=1` runs only the first case once per extension.

No RAM/CPU profile, manual UI score, provider comparison, or production write-workload comparison was performed. Shared provider caches were not reset. With only two repetitions per task, latency conclusions should remain modest.
