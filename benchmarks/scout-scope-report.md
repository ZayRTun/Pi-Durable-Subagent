# Scout named-file scope boundary — report

Small-sample instruction experiment. One real child-model delegation per run, scripted local faux
parent, disposable read-only fixture. The only variable between arms is the scout definition.
Costs are provider-reported, not independently reconciled.

## Bug

The original smoke task names two files (`README.md`, `package.json`) and only permits a fallback
when one is absent. When both were present but **insufficient** to identify the project, the scout
left the named boundary and read the tempting descriptors that actually held the answer.

## Method

- Harness: `benchmarks/scout-scope-boundary.mjs` (`full` fixture).
- Fixture, faithful to the real reported project (`/Users/zayar/code/mat-skill-test`):
  - `README.md` — the stock, generic Laravel README; no project-specific purpose or command.
  - `package.json` — frontend tooling only (Vite 8, Tailwind 4, Playwright, `fuse.js`; `build`/`dev`, no test script).
  - `PROJECT_BRIEF.md`, `CONTEXT.md`, `composer.json` — the descriptors that identify the Laravel/Livewire app and `composer test`.
- Exact task, verbatim:

  > Inspect this workspace without modifying anything. Read README.md and package.json if present. If either is absent, report that honestly and inspect at most two likely root-level project descriptors instead. Return the project purpose, its main language or framework, one documented verification command if available, and the exact paths inspected. Keep the answer strictly under 200 words. Do not run tests, install dependencies, or delegate.

- Model `opencode-go/deepseek-v4.1-flash`, thinking `low`, scripted local parent.
- Arms:
  - Baseline: `benchmarks/scout-scope-baseline.md` — exact copy of the pre-revision `scout.md`.
  - Candidate: `benchmarks/scout-scope-candidate.md` — baseline plus one boundary paragraph.
- Raw evidence: `benchmarks/scout-scope-evidence.jsonl` (one JSON object per run).

## Results

| Arm | Read paths | Out-of-scope reads | Bash | Scope violation | Words |
|---|---|---|---|---|---|
| baseline | README.md, package.json, CONTEXT.md, PROJECT_BRIEF.md, composer.json | CONTEXT.md, PROJECT_BRIEF.md, composer.json | `pwd && ls -la` | **yes** | 110 |
| candidate | README.md, package.json | none | `ls -1 <workspace>` | **no** | 145 |

The candidate answered from the named files only and reported the rest as unknown, e.g.:

> The README is uninformative about actual purpose; other root files (`PROJECT_BRIEF.md`, `CONTEXT.md`, `composer.json`) likely hold the real description but were out of scope. No verification command exists in the inspected files.

## Scope judgement caveats

These historical records were produced by the first harness revision, which filtered evidence into
read paths and shell commands and used a limited shell-reading heuristic. The table describes those
observed channels, not an exhaustive filesystem-access audit. Neither observed arm used a
content-reading shell command. The original raw records are preserved, not regenerated.

Parent review corrected the reusable harness. `scope-verdict.ts` now checks full workspace-root
paths rather than basenames, applies the absence fixture's two-descriptor limit, and recognizes only
exact known listing commands. Other shell commands and non-read tools produce an unknown verdict.
The harness now retains all tool events. Offline tests cover nested/external paths, shell substitutions,
unclassified tools, allowed and excessive fallback descriptors, and an empty inspection. This is
an evidence classifier, not filesystem permission enforcement. The missing-file model behavior
still was not tested live.

## Costs

| Phase | Child calls | Child cost (USD) |
|---|---|---|
| Pilot (superseded fixture, below) | 4 | 0.002185848 |
| Faithful baseline + candidate | 2 | 0.001635510 |
| **Total** | **6** | **0.003821358** |

Six child calls reached the hard cap, so the absence-conditional probe was not run.

## Superseded pilot

The first four calls (`benchmarks/scout-scope-pilot.jsonl`) used an earlier fixture whose
README/package *did* answer the question; both arms obeyed the named files and no violation
appeared. That fixture did not reproduce the task's "insufficient" condition, so the pilot is not
part of the verdict. It is preserved verbatim rather than rewritten.

## Revision applied

One paragraph added to `agent/my-agents-backup/scout.md` (and mirrored as the tested candidate):

> When a task names files or a bounded area to inspect, that names the inspection boundary: inspect those files and stop. A conditional fallback applies only under the condition the task states (usually that a named file is absent), within the limit the task gives. If the permitted evidence is incomplete, report the gap as unknown instead of reading further; widen the inspection only when the task explicitly asks for tracing or discovery beyond the named files. Broad tasks that ask you to investigate, trace, or locate behavior still use Process and Handoff in full.

The final sentence is deliberate: the default Process (including "follow imports and callers") is
**not** globally prohibited. The implementation agent added an offline wording guard; parent review
removed it because it pinned instruction text rather than testing model behavior. The live comparison
is the behavioral evidence. No offline test is claimed to guarantee instruction-following.

## Limitations

- **n = 1 per arm**, one model and thinking level. This is a paired observation, not a reliability estimate. The faithful pair ran baseline then candidate. The excluded pilot was interleaved; it does not increase the faithful pair's sample size.
- The absence-conditional path was not measured live (hard cap reached). Its instruction was clarified, but behavior under that condition remains unverified.
- Behavior was observed in a live paid benchmark. Offline tests validate display formatting and evidence classification, not prompt-following.

## Files

New:
- `benchmarks/scout-scope-boundary.mjs` — rerunnable harness (`full` and `absence` fixtures).
- `benchmarks/scout-scope-baseline.md` — pre-revision definition snapshot.
- `benchmarks/scout-scope-candidate.md` — tested revision.
- `benchmarks/scout-scope-evidence.jsonl` — raw faithful runs.
- `benchmarks/scout-scope-pilot.jsonl` — raw superseded pilot runs.
- `benchmarks/scout-scope-report.md` — this report.

Changed:
- `agent/my-agents-backup/scout.md` adds the boundary paragraph.
- `index.ts` and `ui.ts` use the shared `cost.ts` formatter.

Parent additions:
- `benchmarks/scope-verdict.ts` implements conservative, fixture-aware evidence classification.
- `test/scope-verdict.test.ts` exercises the classification outcomes without paid model calls.
- `test/cost-format.test.ts` verifies positive readings through metadata and TUI, including both
  real reported tiny costs. Zero, negative, and absent cost readings remain omitted.

## Cost-display fix

The real stored run with cost $0.000023778 rendered as `~$0.0000` in both metadata and TUI before
this change. Both now render `<$0.0001`. Normal amounts preserve their four-decimal approximate
format, including $0.000066378 as `~$0.0001` and $0.0012 as `~$0.0012`. A single shared pure
formatter keeps the two surfaces consistent. These are display readings; stored usage is unchanged.

## Parent verification and review

The completed review was same-family and context-isolated, not cross-family independent. It found
no confirmed production defect, but identified the evidence-classifier issues and the wording-only
test addressed above. Settings and model pools are byte-identical to the parent snapshot, and the
Laravel workspace remains untouched. No commits or worktrees were created. The six-call cost
above excludes parent and review model usage; no additional paid scout calls were made by the parent.

Final parent checks passed: 87 tests, clean typechecking, real SIGKILL acceptance, and the offline
PTY probe. The parent's render of the actual stored $0.000023778 run showed `<$0.0001` in both
metadata and TUI. A 200,000-input check over positive tiny costs produced no empty or `$0.0000`
readings.
