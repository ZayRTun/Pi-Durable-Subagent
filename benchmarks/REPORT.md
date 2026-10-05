# Installed pi-subagents vs Pi Durable extension

> Historical pre-fix, low-thinking results. The workspace and loader findings below have since been fixed; see `REPORT-HIGH.md` for regression evidence and the current high-thinking comparison. The original measurements are retained unchanged.

## Scope and method

Compared installed `pi-subagents` 0.74.0 with the current local Durable extension. Twelve measured live child runs: three tasks × two repetitions × two engines. Both used `opencode-go/deepseek-v4.1-flash`, low thinking, fresh foreground conversations, the same concise read-only agent instructions, and `read`/`bash` tool allowlists. Ambient extensions, skills, and inherited project/global instructions were disabled.

A scripted local parent issued the delegation; it did not make paid parent-model calls or choose how to delegate. Each trial used a fresh Node process. Execution order alternated between engines. The installed extension's capabilities and models actions ran before launch. Both delegated through their real Pi SDK tool implementations. Agent registration and temporary fixtures did not change active settings or the original agent definitions.

Tasks:

1. Read a release note and return five exact JSON fields.
2. Inspect a pricing function and identify two shipping bugs, computing actual and correct totals.
3. Trace imports across three files and return the function chain and default configuration.

The measured set explicitly supplied the workspace, named files, and a no-outside-search constraint. Answers were scored by exact JSON structure/values, ignoring object-key order. Token totals include cached input tokens. Dollar amounts are model-rate estimates, not subscription invoices.

## Results: scoped tasks

| Metric | Installed | Durable |
|---|---:|---:|
| Correct answers | 6/6 | 6/6 |
| Mean delegation time | 5.62 s | 4.59 s |
| Median delegation time | 5.29 s | 4.62 s |
| Min–max delegation time | 4.31–8.20 s | 4.04–5.09 s |
| Total tokens | 19,190 | 11,242 |
| Input + cached-input tokens | 17,736 | 10,157 |
| Output tokens | 1,454 | 1,085 |
| Estimated cost, six runs | $0.001632 | $0.001140 |
| Model turns | 12 | 12 |
| File reads | 10 | 10 |
| First progress notification, typical | 38–42 ms | 13 ms |

Durable's mean delegation latency was 18.3% lower; its median was 12.7% lower. Total token consumption was 41.4% lower. Both engines performed the same number of model turns and file reads. Differences therefore were not caused by Durable skipping the required work, although stochastic output length and provider/cache effects contribute.

Average time by task:

| Task | Installed | Durable |
|---|---:|---:|
| Extract release fields | 4.70 s | 4.24 s |
| Review pricing bugs | 6.69 s | 4.99 s |
| Trace imports | 5.47 s | 4.55 s |

Durable was faster in five of six matched trials. One installed review run took 8.20 seconds and influences the mean; the advantage is not uniformly 18% on every task.

## Important failure outside the scoped set

An earlier live pair gave both agents an unscoped task: `Read release.md` without stating the workspace.

- Installed: correct answer in **4.61 seconds**.
- Durable: **timed out after 300.03 seconds**. The child ran a filesystem-wide `find` for `release.md` rather than reading the relative path directly.

This failure is retained separately in `measurements.json`, not counted as a successful scoped run. The Durable implementation stores the working directory but does not automatically render it into the child's prompt. The observation exposes a real workspace-context/scoping weakness; one stochastic failure does not establish its frequency. Explicit workspace instructions avoided it in the measured set. The extension source was not patched during the comparison.

## Setup blockers and loading caveat

The first harness omitted SDK `bindExtensions()`, so the temporary native agent was not registered. It stopped at capability discovery before launching work. That was corrected through the same extension path.

The bundled SDK/Jiti extension loader failed to resolve Durable's `pi-ai/models` import, producing a path ending in `pi-ai/dist/compat.js/models`. This reproduced in a fresh process. The regular Pi CLI had loaded Durable successfully previously. For the measured comparison, Durable used the SDK's supported inline-extension factory, while installed pi-subagents used its normal JS loader. This loading incompatibility remains a separate integration finding.

Observed host initialization averaged 532 ms installed vs 256 ms Durable; whole-process wall time averaged 7.69 s vs 5.83 s. **Do not treat those as pure engine startup benchmarks**, because the loading paths and native management preflight differ. The main latency table measures from the actual delegation tool's launch to completion and excludes capability/model management calls.

## Interpretation and recommendation

For small, explicitly scoped foreground delegations, Durable is promising: correct results, fewer tokens, and modestly lower latency in this sample. The installed extension currently has stronger surrounding orchestration and observability capabilities: async/detached execution, workflows, fleet inspection, steering, and related controls. Those capabilities were not performance-tested here; our minimal extension deliberately does not provide them.

Do not replace the installed extension solely on these timings. Before using Durable as the default, add explicit workspace context to every child prompt, strengthen scope guidance, and regression-test the normal loader and restart/resume integration. The unscoped-task timeout matters more to practical reliability than saving roughly one second on the successful tasks.

Limitations: six scoped runs per engine, one model, low thinking rather than the user's usual high setting, tiny read-only fixtures, shared provider prompt caches that were not reset, no write workloads, no crash/recovery comparison, no RAM/CPU profiling, and no manual TUI comparison. This is a useful pilot, not a universal speed or reliability ranking.

## Evidence and reproduction

- Sanitized per-trial measurements and the earlier failure: `measurements.json` alongside this report.
- Complete scoped run artifacts: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/pi-subagent-comparison-hsinvV/`.
- Earlier timeout artifacts: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/pi-subagent-comparison-ggz3Hr/`.
- The current runner is `node --experimental-strip-types agent/durable-subagent/benchmarks/compare.mjs`; it now defaults to high thinking, normal loading, and an expanded case set. It does not reproduce this historical pre-fix implementation. `BENCH_THINKING=low` selects low thinking on the current implementation.

Temporary artifacts may be cleaned by the operating system; the sanitized measurements are retained in the repository. No active extension configuration was switched.
