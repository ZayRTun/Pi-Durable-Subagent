# Durable follow-up: live evaluation and comparison vs `pi-subagents` 0.74.0

Run after the operator-evaluation fixes. Two independent checks: a fresh head-to-head benchmark on identical tasks, and a real end-to-end run through the actual `pi` CLI.

Both used **live model calls** to `opencode-go/deepseek-v4.1-flash` at **high thinking**. Nothing in this document is a paid-plan invoice; cost figures are model-rate estimates for the child's tokens only. Active configuration was not changed for either run: `pi-subagents` remains the enabled extension, and Durable was loaded explicitly per invocation.

## 1. Head-to-head benchmark

Method is unchanged from `REPORT-HIGH.md`, with a fresh `BENCH_DIR` and fresh processes:

- Same read-only role, same `read`/`bash` allowlist, same model and thinking for both engines.
- Scripted local parent, so the parent makes no network calls; only the Sub-agent spends.
- Normal SDK file loading for both extensions, no ambient extensions/skills/project context.
- 5 tasks × 2 repetitions × 2 engines = **20 Sub-agent runs**; alternating engine order; 60-second deadlines.
- String/JSON value scoring; fresh foreground conversation per delegation.

Raw records: [`measurements-compare-followup.json`](measurements-compare-followup.json).

| Metric | installed 0.74.0 | Durable |
|---|---:|---:|
| Correct answers | 10/10 | 10/10 |
| Failed or timed out | 0 | 0 |
| Mean time | 6,798 ms | **6,036 ms** |
| Median time | 5,550 ms | 5,438 ms |
| Range | 4,516–13,076 ms | 4,577–9,460 ms |
| Uncached input tokens | 11,005 | **4,740** |
| Cache-read tokens | 26,112 | 18,944 |
| Output tokens | 4,304 | **1,985** |
| Total tokens | 41,421 | **25,669** |
| Model turns | 23 | 24 |
| Tool calls | 30 | **22** |
| Estimated model cost | $0.004311 | **$0.001959** |
| Cached-input share | 63.0% | 73.8% |

Per task, mean time:

| Task | installed | Durable |
|---|---:|---:|
| Release extraction, scoped | 4,754 ms | 4,793 ms |
| Pricing review | 5,864 ms | 5,701 ms |
| Import tracing | 5,551 ms | 5,438 ms |
| Relative path, no workspace in the task | 4,913 ms | 4,924 ms |
| Larger five-file inspection in a 34-file fixture | **12,907 ms** | **9,326 ms** |

**Read this carefully.** Both engines answered every task correctly, and four of five tasks are within ~3% on time — that is a tie. The mean gap comes almost entirely from the larger task, where the Durable Sub-agent used 5 tool calls in both repetitions against 8 and 10. With two repetitions per task this is consistent but weak evidence; it may reflect the prompt's named-paths-first and bounded-discovery guidance, or just model variance. Do not claim a general latency win.

The more defensible difference is spend: Durable's Sub-agents used roughly **half the tokens and half the estimated cost**, driven by fewer uncached input tokens and much less output. Provider caches were not reset between the two engines, so treat the cached-input split as an observation, not a controlled result.

## 2. Real end-to-end CLI run

`benchmarks/cli-live.mjs` exercises the actual `pi` binary rather than the SDK: Durable loaded with `-e`, its own tool registration path, real provider auth, real nested tool calls, and a second process for retrieval.

The fixture is a five-file repository whose README specifies after-discount shipping while the code computes pre-discount shipping.

| Phase | Result |
|---|---|
| Delegate | `succeeded` in 18.6 s; entry point `src/index.ts`; chain `main → settings → quote`; correct finding (actual 48, correct 53); all five files inspected; 5 honest verification gaps including the missing test suite; reported `ls`, `fffind`, `ffgrep` unavailable |
| Child usage | 7,554 tokens, estimated **$0.00082** |
| Repository integrity | SHA-256 of every file identical before and after |
| Retrieve (new process) | `succeeded` in 7.0 s; `run.json` **byte-identical**; `updatedAt` unchanged; exactly one run record; **no new spend reported to the parent**; cached answer returned |

This is the first check of the whole path through the real CLI including retrieval, and it passes. Evidence: `/var/folders/zk/6zwx9y7n6g5_3qgr3_62x0xr0000gn/T/durable-cli-live-07Hyxc/` (temporary; contains `delegate.events.jsonl` and `retrieve.events.jsonl`).

Both runs also confirm the capability-honesty behaviour: with `--no-extensions`, `ls` and the `fff` tools are genuinely absent, the Sub-agent says so, and it completes the task with `read`/`bash` rather than silently widening scope.

## 3. Capability comparison

The two extensions are not substitutes. Installed `pi-subagents` 0.74.0 is a broad orchestration platform; Durable is a deliberately narrow blocking delegator.

| Capability | pi-subagents 0.74.0 | Durable |
|---|---|---|
| Built-in agents | 7 (scout, researcher, evidence-auditor, worker, reviewer, oracle, delegate) | Uses the repository's own definitions only (4) |
| Execution | Blocking **and** background/async | Blocking only |
| Parallel / workflows | Chains, scripted workflows, council, review loops | One delegation per working directory; no chains |
| Worktree isolation | Yes, opt-in | No |
| Missions / schedules | Timed and recurring runs | No |
| Observability | FleetView, fleet inspector, artifacts, events, logs | Compact row plus expanded per-run detail and `/subagents` |
| Crash recovery | Session-scoped | Per-run SQLite; reopen is paused and needs explicit approval |
| Recovery approval | — | Required interactively or via `--subagent-resume` |
| External CLI runners, watchdog, MCP/extension API | Yes | No |
| Per-agent memory, model profiles | Yes | No |
| Recursion guard | Yes | Rejects definitions declaring `subagent` |
| Tool loadout | Broader configuration surface | Allowlist ∩ currently callable tools, never widened; `codemode`/`tool_search`/`subagent` never bridged |
| Result retrieval cost | — | Zero new model calls, record untouched (verified above) |

Durable's advantages are narrow and verifiable: it is smaller, spends less per delegation in this fixture, refuses to widen permissions, and treats crash recovery as a first-class state machine with explicit operator approval. It does not attempt anything `pi-subagents` already does better, such as parallel review, background work, or research with sources.

## 4. Real-work measurement in a Laravel repository

Synthetic fixtures score correctness well but say nothing about cost on real code. Earlier operator-run results on real work were scout 33 s / 105k tokens, researcher 282 s / 1.95M, reviewer 956 s / 2.32M — so cost, not latency, is the open problem.

One real read-only task was measured in `/Users/zayar/code/mat-skill-test`: map how the Model Catalog is fetched and cached for the setup wizard, starting from the Livewire component and following the code to the OpenRouter service. The Sub-agent definition is the operator's own `scout`; model and thinking are the real defaults (`opencode-go/deepseek-v4.1-flash`, inherited `high`).

### Where the cost actually goes

Instrumenting one run gave a clean split. The child's request is lean: its system message is a single `instructions` section plus the tool schemas (~360 tokens), with no parent system prompt, context files, or codemode notes. Steady-state cost came almost entirely from the child's own work:

| Component | Tokens | Cost | Share |
|---|---:|---:|---:|
| Tool results (uncached input) | 27,738 | $0.0046 | 50% |
| Output, including thinking | 6,760 | $0.0041 | 45% |
| Cache reads | 143,232 | $0.0004 | 5% |

The single largest item was one **28,062-character whole-file read** of a Blade view — 25% of all tool output. Pi's `read` supports `offset`/`limit` and truncates at 50 KB, so the child chose to read the entire file.

**Total tokens is a misleading metric here.** One cached-heavy run reported 157k tokens at lower cost than a 112k-token run, because cache reads cost ~50× less per token than uncached input or output. Cost is the metric that matters; token totals should not be quoted alone.

### Before/after: bounded-context guidance

One sentence was added to the shared instruction builder asking the child to read the region it needs from long files and to prefer narrow paths and bounded output. The aim is to cut oversized tool results without removing information or imposing a hard cap.

Six runs, three before and three after, identical task, model, thinking, and tool availability:

| Metric | before (mean) | after (mean) | change |
|---|---:|---:|---:|
| Estimated cost | $0.009072 | $0.007044 | **−22%** |
| Total tokens | 225,195 | 130,096 | −42% |
| Tool result characters | 91,816 | 66,414 | −28% |
| Tool calls | 23 | 18 | −24% |
| Uncached input | 28,380 | 22,016 | −22% |
| Cache reads | 189,739 | 102,357 | −46% |
| Output | 7,076 | 5,723 | −19% |
| Wall time | 99 s | 98 s | −1% |
| Assistant rounds | 13 | 12 | −12% |
| Correct answers | 3/3 | 3/3 | — |

Per-run cost, and why the result is credible despite a small sample:

- before: `$0.009066`, `$0.009408`, `$0.008742`
- after: `$0.007565`, `$0.006981`, `$0.006585`

The two ranges **do not overlap**, and every after run is below every before run. Latency is unchanged, which is expected: wall time is dominated by model generation, not by tool count. Correctness was verified against the repository, not just plausibility-checked: the child reported `Cache::remember(CACHE_KEY, now()->addHour(), …)`, the `fresh()` cache bypass, and the caught `RuntimeException`, which match `app/Services/OpenRouterModelService.php` exactly.

Three samples per arm is still a small sample. The mechanism is the credible part — fewer and smaller tool results, and no regression in correctness or speed.

### Sequential tool execution: a deliberate speed ceiling

The child issued **parallel tool calls in 7 of 10 assistant messages** (up to four at once), but Durable pins `toolExecution: "sequential"`, so those calls run one at a time. Of the seven multi-call rounds, only two were pure reads; five mixed `read` with `bash`, and mixed rounds stay sequential anyway because the mutating tool dominates the round.

Enabling parallelism would require deciding which tools are safe to run concurrently. Pi's `ctx.tools` exposes no `annotations`, no `readOnlyHint`, and no `executionMode` for the bridged tools, and the built-in tools carry no annotation either, so the choice would rest on a name heuristic. Given the bounded upside — on this workload it can only help rounds that are entirely read-only, and the measured cost per round is dominated by model generation — the conservative setting is kept, and the trade-off recorded rather than removed.

Raw evidence: `/tmp/durable-laravel-Spaex5`, `/tmp/durable-laravel2-cBjtGm`, and the `/tmp/durable-ab-*` directories (temporary).

## 5. Worker task: real implementation against a real ticket

Reads only exercise half the extension. `worker` writes files, runs the gate, and reports a handoff — that is where reliability matters.

**Setup.** Ticket #27 ("Report interview counts by status in the health endpoint") from the operator's own tracker, labelled `ready-for-agent`, blocker #25 closed. The operator's `worker` definition was used unchanged, inheriting the real model and thinking level. Each run got a fresh APFS clone of the Laravel repository, so the operator's working tree was never touched and each sample started identical. Baseline gate on the clone: **247 tests / 823 assertions** in 57 s.

The seam is not trivial: an existing test asserts the health payload is *exactly* `{status, database}`, so adding counts forces the Sub-agent to decide whether to change a test that encodes the old contract.

| | sample 1 | sample 2 |
|---|---:|---:|
| Status | succeeded | succeeded |
| Wall time | 155.3 s | 183.8 s |
| Tool calls | 26 | 30 |
| Estimated cost | $0.009178 | $0.011749 |
| Cache-read tokens | 207,872 | 355,712 |
| Output tokens | 8,447 | 10,938 |
| Files changed | 2 | 2 |
| Independent full gate | **249 tests, 827 assertions, passed** | **249 tests, passed** |

**Verified independently, not taken from the handoff.** In both samples only `HealthController.php` and `HealthEndpointTest.php` changed; no unrelated edits, no commits, no new branches. I re-ran the full suite myself. The implementation aggregates with `sum(case when status = ... end)` over `Session::query()->toBase()`, casts to `int`, and always emits all three keys so an empty status is zero rather than absent. The `in_progress`/`completed`/`cancelled` set is the complete set — the model maps to `interview_sessions`, the factory defines exactly those three states, and there are no soft deletes.

Both runs also strengthened the no-secrets test to check the nested object's key set, and both **updated** the exact-shape test rather than working around it.

**Both runs surfaced a real design decision.** Neither reported counts on the `503` path, because a database that cannot be read cannot yield trustworthy zeroes. Sample 1 stated it explicitly as a follow-up for the invoking agent, with the one-line alternative if different behaviour is wanted. That is the behaviour the definition asks for: proceed on the literal reading and surface the decision instead of silently guessing.

**Gaps worth noting.**

- The payload key is `interviews`, while `CONTEXT.md` defines the term as **Interview Record**. Both runs chose the shorter name; the glossary would suggest `interview_records`. A naming nit, not a defect.
- Counts are global across users. Correct for an operator-facing health signal, but it means the numbers do not sum to a per-user view.
- Neither run followed strict red-green TDD. Both wrote implementation and tests, then ran the focused test and the full suite. The worker definition asks for `/tdd` *when the task provides a confirmed seam*; the parent prompt here did not pre-agree one.
- Discovery cost is overstated by this measurement. With `--no-extensions` the `fff` tools and `ls` were unavailable, so both runs spent about half their calls on `bash` `grep`/`find`/`cat`. The operator's real configuration has those tools, so real discovery should be cheaper and leaner.
- One run read two files from `vendor/laravel/framework` to confirm `selectRaw` behaviour. Reasonable without the Laravel Boost `search-docs` tool available; in the real configuration that lookup would be a documentation search.

**Cost context.** A ticket-sized implementation including a full 46–57 s suite run cost $0.009–$0.012, against $0.007 for the read-only scout task. Reliability was 2/2 with no timeouts, lock errors, retries, or lock conflicts, and both samples converged on the same two files and the same test count.

## 6. Reviewer pass over the committed diff

The second half of the implement loop: a `worker` run that commits, then a `reviewer` run over that exact commit. Same disposable-clone discipline; the operator's repository was never touched.

The worker again took ticket #27 and this time committed to the current branch as instructed, producing `cbacdb9 feat(health): report interview record counts by status (#27)` on a clean tree — three files this time, since it also split the unreachable-database test into its own file. The reviewer then received the fixed point (`80d3f62`) and the ticket text, and was asked for both axes.

| | value |
|---|---|
| Reviewer status | succeeded |
| Wall time | 99.3 s |
| Tool calls | 30 (23 `bash`, 7 `read`) |
| Estimated cost | $0.011979 |
| Tree after review | clean, no new commit, no edits |

Read-only behaviour held: the working tree was unchanged and the commit list was identical after the review, despite the reviewer having `bash` and `read` available.

### Every finding was verified, not accepted

**Medium — real bug, reproduced.** The reviewer claimed the new count query runs outside the existing `try`/`catch`, so a database that answers the `select 1` probe but lacks the `interview_sessions` table would throw an uncaught `QueryException` and return a **500 HTML error page instead of JSON** — breaking the parseable payload the class docblock promises.

That is a precise, falsifiable prediction, so I tested it rather than trusting the reasoning. Dropping the table in a throwaway Pest test and requesting `/health` reproduced it exactly:

```
PROBE status=500 content-type=text/html; charset=utf-8
PROBE body-start=<!DOCTYPE html>
```

The original endpoint was safe because its only query was guarded, so this is a defect the worker *introduced*. It is also squarely inside the ticket's own subject matter — a health endpoint during a failed migration is exactly when an operator needs machine-readable output.

**Low — inline comment against repo rules.** Confirmed in the diff: a two-line `//` rationale for a simple `if`, where `AGENTS.md` says to prefer PHPDoc and reserve inline comments for exceptionally complex logic.

**Low — duplicated aggregate.** Confirmed: `DashboardController::totals()` carries the same three `sum(case when status = …)` expressions. The reviewer correctly noted the difference is scoping only (dashboard is per-user, health is global), which is why a shared helper needs a scope parameter rather than a straight extraction.

**Low — no index or central status set.** Confirmed: the migration defines `status` with no index, and the three statuses are raw string literals in the factory, the prune command, the dashboard, and now health. The literal-drift concern is sound. The accompanying "full-table scan" phrasing is slightly imprecise — a global aggregate over all rows scans regardless of a `status` index — so that sub-claim is weaker than it reads.

**Low (Spec) — literal partial miss.** The reviewer flagged that criterion 1 says the response "includes interview record counts grouped by status" with no qualification, while the payload omits `interviews` entirely on the `503` path. It judged this defensible, explained why zeroes would misrepresent an unreachable database, and asked only that the contract be documented. **The worker had independently reached the same conclusion**, which is a useful cross-check: one agent decided it, the other challenged and then endorsed it.

Beyond findings, the reviewer resolved the requested fixed point, reviewed exactly `80d3f62...cbacdb9`, read `AGENTS.md`/`CONTEXT.md`/`CLAUDE.md` and the migration before judging conventions, reported Standards and Spec **separately** rather than collapsing them into one score, and listed its own verification gaps — including that it had not executed the suite or Pint, and that no spec file exists for this ticket so the ticket body was the only Spec source.

### What the loop demonstrated

The value here is not that the reviewer produced text. It is that a fresh context, given the diff and the ticket, found a genuine robustness defect the author introduced, predicted its symptom precisely enough to falsify, and let a third party confirm it in under a second — while inventing nothing I could not substantiate. That is the property the `worker` → `reviewer` half of the implement loop depends on.

## 7. Reviewer sensitivity: planted defects

Section 6 showed the reviewer found a real bug. That does not establish how much it *misses*. This arm measures detection directly.

**Method.** The worker's implemented-and-committed state was taken as the base, and three defects were planted at three difficulty levels. One constraint made the test meaningful: because the worker's test suite pins every acceptance criterion, any *literal* violation is already caught by its own tests, so the planted defects had to be **test-silent**. The full suite was run with the defects in place and stayed green — **249 tests, 832 assertions, passed** — confirming a reviewer could not find them by noticing a red test.

| # | Planted defect | Difficulty | Detected |
|---|---|---|---|
| 1 | A catch-all around the counts that reports fabricated zeros while the response still says `status: ok` / 200, making "query failed" indistinguishable from "no records" | hard | **yes** |
| 2 | Three separate `count()` round-trips where the codebase already uses one grouped aggregate | medium | **yes** |
| 3 | Missing explicit return type and missing PHPDoc array shape on the new method | easy | **yes** |

**3/3, and each was classified correctly.** The hardest defect was raised as the report's top finding ("Medium, design smell"), with the reviewer reasoning that it "silently makes 'query failed' indistinguishable from 'no records' — the exact ambiguity AC3 asks the endpoint to avoid", and contrasting it with `databaseIsReachable()`, which factors failure into the status code instead of swallowing it. That is the intended criticism, arrived at independently. The query-shape defect was matched to the existing `DashboardController::totals()` convention, and the type/PHPDoc defect was matched to the exact `AGENTS.md` rules and to the sibling method that already complies.

**Two bonus findings, both real.** Beyond the planted defects the reviewer reported two things I had not planted, and I verified each:

- the failure test restores the connection by hardcoding `'sqlite'` instead of capturing the original value — confirmed, and confirmed that `phpunit.xml` pins `DB_CONNECTION=sqlite`, so it works but is brittle. That is a genuine, subtle observation about the worker's *test* code.
- the status vocabulary is duplicated across `HealthController`, `DashboardController`, and `SessionFactory` — confirmed.

**No false positives.** I checked every claim it made: the hardcoded restore, the `phpunit.xml` pin, the absence of `docs/adr`, and that `docs/specs/ai-interview-grilling-app.md` mentions health zero times, which is why it treated the ticket body as the only Spec source.

**Calibration, not just detection.** It reported **Spec: pass**, listing all six acceptance criteria as met, and declined to promote the zero-filling defect into a literal AC violation — calling it a design smell against AC3's *intent* instead. It also declined to run the suite or Pint and said so under verification gaps. A reviewer that manufactures spec failures or hides its unverified assumptions would be worse than one that misses.

| | value |
|---|---|
| Reviewer status | succeeded |
| Wall time | 59.2 s |
| Tool calls | 14 |
| Estimated cost | $0.007437 |
| Working tree after review | unchanged, no new commit |

A harness bug in this arm is worth recording, because it is the kind of thing that produces false conclusions. The first planting script truncated the controller from the wrong marker and deleted `databaseIsReachable()`, which made the suite fail with 500s across the board and cascading "cannot start a transaction within a transaction" errors. That looked briefly like a Durable or worker failure. The actual exception (`Call to undefined method HealthController::databaseIsReachable()`) identified it as my own edit, the plant was rewritten to preserve the worker's structure, and the suite then passed with the defects in place. The failure was in the experiment, not the extension.

## 8. Mutation score, and the same defect reviewed twice

Section 7 planted defects that I chose. This arm removes the author bias: defects are generated mechanically instead.

### Generating defects without judgement

Single, small mutations were applied to the implementation the worker committed, and each was run against the focused health test file. Anyone can reproduce the set; nothing in it depends on my idea of what a bug looks like. Twelve mutations applied, **nine killed, three survived**.

The three survivors were then examined individually, and all three are semantic no-ops rather than defects:

- Replacing `?? 0` with `?? null` is neutralised by the surrounding `(int)` cast — `(int) (null ?? null)` and `(int) (null ?? 0)` are both `0`, verified directly in PHP.
- Removing `->toBase()` still returns correct counts, because Eloquent hydrates the selected aliases as model attributes; the counts test (2 in-progress, 3 completed, 1 cancelled) still passes.
- Rewriting the probe as `select 1 from interview_sessions limit 1` is test-indistinguishable, and arguably preferable, since it would sidestep the failure mode below.

So the mutation score on behavioural mutants is effectively **100%**. This worker's tests pin the implementation's logic, payload shape, status codes, and no-leak property tightly enough that a mechanical defect generator cannot produce a genuine test-silent bug. That is a statement about the *worker's* test quality, and it is the reason section 7 had to plant gap-class defects rather than logic errors.

### The defect tests cannot reach

That result also shows where a reviewer is actually load-bearing. The same baseline carries a real defect that no logic mutation could express and no test asserts: `interviewCountsByStatus()` runs unguarded behind a probe that only checks `select 1`, so a reachable-but-unqueryable database produces a 500 HTML page. Reproduced in this clone:

```
PROBE status=500  type=text/html; charset=utf-8
```

### Two independent reviewers on the identical diff

Two fresh reviewer runs then reviewed the same honest diff (`80d3f62...4e91b64`).

| | reviewer A | reviewer B |
|---|---:|---:|
| Status | succeeded | succeeded |
| Wall time | 83.7 s | 113.4 s |
| Tool calls | 25 | 25 |
| Estimated cost | $0.010714 | $0.014525 |
| Found the unguarded-query defect | **yes, High** | **yes, Medium (raised again under Spec)** |
| Working tree after review | unchanged | unchanged |

Both found it, with closely matching reasoning: the probe can succeed while the aggregate query fails, so the endpoint's "reachable implies a stable success payload" guarantee is not actually held. Reviewer A went further and observed that `APP_DEBUG=true` (verified at `.env:4`) makes the resulting error page a potential SQL and connection-detail leak, which ties the defect back to the no-leak criterion. Reviewer B found an additional Spec source the earlier reviewer had declared absent — `docs/specs/ai-interview-grilling-app.md:82` documents the `in_progress`/`completed`/`cancelled` status enum — also verified.

Every factual claim in both reports held up when checked: the `.env` debug flag, `bootstrap/app.php:18-20` forcing JSON only for `api/*` (which is precisely why the failure renders as HTML), the later `user_id` migration, the absence of any index on `status`, and the enum in the spec.

**Three independent reviewers have now examined this defect** — one in section 6, two here — and all three found it. Detection was unanimous, and I found no false claim in any of the three reports.

### What did diverge: grading, not finding

Classification was not consistent. The same underlying defect was rated High once and Medium twice, and the Spec axis was judged Fail, Fail, and Pass across the three runs on essentially the same code. Since a Spec failure is what gates a merge in an implement-then-review loop, that spread is the honest limitation: the reviewer is dependable at *finding* problems and less dependable at *grading* them. The deliberate two-axis split used by `/code-review` helps, but severity still needs a human to arbitrate.

## 9. Thinking level: cost against detection

Output plus thinking was ~45% of the cost of a real delegation, and `thinking` is commented out in all four of the operator's definitions, so every role inherits the parent's `high`. That makes it the largest untouched lever, and the only one that needs no code change.

The reviewer was chosen as the test role because it is the most expensive in the operator's real results and because detection can be scored objectively rather than judged.

**Method.** The child's level was set explicitly per arm through an isolated definitions directory, so the parent's thinking stayed constant and only the Sub-agent varied. Same diff (`80d3f62...2f1318a`), same prompt, same model, same tool set. Three levels, two runs each, with the second round in reverse order so drift does not favour one arm.

**Ground truth.** The commit under review contains a real, tests-invisible defect: the status aggregate runs unguarded behind a probe that only checks `select 1`, so a reachable-but-unqueryable database returns a 500 HTML page. Reproduced in the clone before the arms ran (`status=500 type=text/html`). Detection is therefore measurable, not a matter of taste.

| Level | Runs | Mean cost | Mean output tokens | Mean wall time | Mean tool calls | Found the defect |
|---|---:|---:|---:|---:|---:|---:|
| high | 2 | $0.015147 | 14,608 | 112 s | 25.5 | 2/2 |
| medium | 2 | $0.012768 | 12,119 | 100 s | 25.0 | 2/2 |
| low | 2 | $0.009953 | 8,622 | 75 s | 24.5 | 2/2 |

Paired within each round, which is the honest comparison:

| Round | high | medium | low |
|---|---:|---:|---:|
| 1 | $0.012723 | $0.010559 (−17%) | $0.006721 (−47%) |
| 2 | $0.017570 | $0.014976 (−15%) | $0.013185 (−25%) |

**The variance trap.** Round 2 cost roughly 35% more than round 1 at *every* level — run-to-run drift exceeded the effect being measured. Comparing low in round 2 ($0.013185) with high in round 1 ($0.012723) would have shown the cheapest setting as the *most expensive*. Only the paired design makes the ordering mean anything, which is why the arms were interleaved by round.

**Detection held at every level: 6/6.** Even `low` found the unguarded query and named the consequence in both runs. Thinking level is not load-bearing for *finding* this defect.

**Grading did not hold.** Five of six reports rated the defect Medium or higher and recorded Standards findings. The `low` run in round 1 rated it **Low** and reported **Standards: Pass**, despite describing the same failure mode. That is an under-grading error on a defect that breaks the endpoint's stated guarantee, and it appeared only at the lowest level.

**No false claims.** One claim looked suspicious — a reference to `.claude/skills/pest-testing` — and turned out to be correct: the repository does contain `.claude/skills/` with `laravel-best-practices`, `livewire-development`, `pest-testing`, and `tailwindcss-development`. If anything, the higher-thinking run read more of the repository, not less.

### Recommendation for the operator's definitions

`thinking` is their setting and their files were not modified, but the evidence supports a per-role policy rather than one inherited default:

- **reviewer → `medium`.** About 15–17% cheaper with detection and grading both intact across two paired rounds. This is the change I would make first.
- **Keep `high` available for high-stakes diffs.** The saving is real but modest, and grading is what gates a merge.
- **Do not set `reviewer` to `low`.** It found the defect but softened its severity and passed the Standards axis; a review that under-grades is worse than one that costs more.
- **`low` is worth testing for `scout` and `worker`**, where the task is retrieval and implementation rather than adversarial judgement. This experiment does not cover those roles, so that claim stays open.

**Scope limit:** this measured the reviewer only. Extrapolating the numbers to `scout` or `worker` would be unjustified, and the 47% figure is a single run, not a stable effect.

Raw evidence: `/tmp/think-*.json` and `/tmp/think-*.txt` (temporary).

## 10. Scout and worker: thinking level, and what the gate cannot see

Same paired design as section 9 — explicit per-role thinking, two runs per level, second round reversed so drift cannot favour an arm.

### Scout: read-only mapping

Scored against six facts the answer must contain: the cache key, the TTL, the service class, the `fresh()` bypass, the Livewire component, and the config entries. Every run at every level contained all six.

| Level | Mean cost | Paired, round 1 / 2 | Mean time | Mean tool calls | Facts found |
|---|---:|---|---:|---:|---:|
| high | $0.006360 | $0.006784 / $0.005936 | 48 s | 18 | 6/6 both runs |
| medium | $0.005883 | $0.005979 / $0.005788 | 39 s | 16.5 | 6/6 both runs |
| low | $0.004510 | $0.005362 / $0.003658 | 32 s | 13 | 6/6 both runs |

Paired against high: medium −12% and −2%; **low −21% and −38%**. `low` was also faster and used roughly a third fewer tool calls, while producing shorter answers that still carried every required fact. For this read-and-report role, `low` looks strictly better.

### Worker: a real ticket

The same ticket #27, each run in a fresh clone, scored two ways: the repository's own gate, and an **independent oracle** — my own acceptance tests, written before the runs, checking the counts, the zero case, and the unreachable-database payload.

| Level | Mean cost | Paired, round 1 / 2 | Mean time | Mean tool calls | Gate | Independent oracle |
|---|---:|---|---:|---:|---|---|
| high | $0.011849 | $0.012403 / $0.011294 | 156 s | 27 | 250/250, 249/249 | omit / zero-fill |
| medium | $0.012706 | $0.014678 / $0.010734 | 254 s | 29.5 | 250/250, 249/249 | zero-fill / omit |
| low | $0.006455 | $0.004577 / $0.008334 | 124 s | 21.5 | 249/249, 249/249 | zero-fill / omit |

**All six runs passed the full gate and touched only intended files.** Cost paired against high: low −63% and −26%; medium +18% and −5%, so `medium` bought nothing for this role. `low` also used fewer tool calls and far fewer output tokens.

### The finding that matters is not about thinking

The oracle failed three of six runs, and every failure was the same assertion: on the unreachable path the response carried `interviews: {in_progress: 0, completed: 0, cancelled: 0}` alongside `status: failing` and `database: false`. The other three omitted the key entirely.

That split is **1-and-1 inside every thinking level**, so it is not a quality effect of thinking. It is a specification gap: the ticket never says what the counts field should contain when the database cannot be read, so the worker decides. Reporting zeroes there is the *false-zero* hazard — "no interviews" instead of "unknown" — on an endpoint whose stated purpose is spotting a stalled instance.

The sharper part: the zero-filling runs **wrote their own test asserting the zero-filled payload**. Their suite is internally consistent, so a passing gate cannot adjudicate the ambiguity — it confirms that implementation against that test, whichever interpretation was chosen. Only an independent oracle, or a spec that states the contract, can tell the two apart.

For an agent-implemented ticket flow this is the useful lesson: **a green gate is evidence of self-consistency, not of correctness against the ticket.** Ambiguity is resolved silently by the implementer and then locked in by its own tests. The fix belongs upstream, in `/to-spec` or `/to-tickets` — say what happens on the failure path — and it is a reason for a reviewer to treat error-path behaviour as a spec question rather than a style one.

### Recommendation, now with all three roles measured

- **`scout` → `low`.** 21–38% cheaper, faster, fewer tool calls, and no loss of required facts across six runs.
- **`worker` → `low`.** 26–63% cheaper with gate parity and no correctness difference attributable to thinking. Skip `medium`; it showed no benefit.
- **`reviewer` → `medium`, never `low`** (section 9). Detection survived at every level, but the only under-grading came from `low`.

| Illustration: scout + worker + reviewer | Cost |
|---|---:|
| all three inherited `high` | $0.033356 |
| scout and worker `low`, reviewer `medium` | **$0.023733 (−29%)** |

That figure is an illustration from per-role means, not a measured end-to-end ticket, and it excludes the parent's own tokens.

**Limits.** Two runs per level per role, so the cost ranges are indicative and a rare correctness failure is not excluded. The oracle encodes my reading of an under-specified criterion: zero-filling on the unreachable path is a defensible choice, and the finding is the *ambiguity*, not a proven defect in any single implementation.

Raw evidence: `/tmp/scout-*.json`, `/tmp/worker-*.json`, `/tmp/golden.php` (temporary).

## 11. What this does not show

- **Two repetitions per task** in the head-to-head, **three per arm** in the Laravel before/after. Directional, not statistical.
- **No shared-cache control.** Runs happened in sequence; provider caches were warm for parts of each.
- **No concurrent-edit workload.** Every run was a single delegation; no test of two writers, worktrees, or merge conflicts.
- **Detection is not the same as grading.** Three reviewers all found the same real defect, so misses are not the observed failure mode; disagreeing severity and Spec verdicts are. Three runs cannot establish a miss rate, and the hand-planted defects in section 7 were mine.
- **No qualitative UX scoring.** Readability and styling were reviewed by the operator previously, not measured here.
- **Child tokens only.** Parent-side cost from carrying the result is excluded, which matters because Durable caps conversation-visible results while `pi-subagents` has its own policy.
- **One task, one repository.** The −22% cost result is from a single read-only mapping task in one Laravel codebase.

## 12. Findings and recommendation

No extension defects surfaced in this round. Every failure encountered was a harness bug: an isolated agent directory that lost provider credentials, an assertion using Pi's `tool_result` name instead of the real `tool_execution_end` event, a shell-pattern mistake while toggling the prompt for the A/B, and a defect-planting script that truncated the controller and briefly looked like an extension failure. All were fixed in the harness, and the last one is recorded in section 8 because it is exactly the kind of mistake that produces a false conclusion.

What the measurements establish:

- **Overhead is negligible.** The child's system message is ~360 tokens of instructions plus tool schemas. It inherits neither the parent's system prompt nor its context files, and bridged tool descriptions carry no codemode notes (`ctx.tools` exposes raw descriptions).
- **Cost is set by the child's own behaviour**, split roughly evenly between tool results and output/thinking. Two levers dominate: how much raw output tools return, and the inherited thinking level.
- **The loop works end to end.** A worker implemented and committed a real ticket against a real gate, and a fresh-context reviewer then found a genuine defect the worker had introduced, predicted its symptom precisely enough to falsify, and nothing I could not substantiate. Both runs respected their roles: the worker touched only intended files, the reviewer changed nothing.
- **Review is not free but is cheap relative to its value.** $0.007–$0.012 and 59–99 s to review a 105-line diff, against $0.009–$0.012 and 155–184 s to produce it.
- **The reviewer is sensitive and does not invent.** It detected 3/3 hand-planted, test-silent defects, then found a real unguarded-query defect on an honest diff in three separate runs, and produced several further findings I verified as real. Across five reviewer runs I found no false claim. Its weakness is grading, not finding: the same defect drew High and Medium, and Spec Fail and Pass.
- **The worker's tests are strong enough to make mutation testing unproductive as a defect source.** 9 of 9 behavioural mutants were killed; the three survivors are provably equivalent. Test-silent defects in this codebase are gap-class (robustness, conventions), not logic errors, which is exactly where review adds value.
- **Bounded-context guidance pays.** One sentence cut estimated cost 22% on a real task with no correctness or latency regression, via fewer and smaller tool results and fewer rounds.
- **Total tokens misleads.** Cache reads are ~50× cheaper; report cost.
- **Sequential execution is a real but bounded speed ceiling**, kept deliberately because no reliable read-only signal exists for bridged tools.
- **Thinking level is the cheapest large saving available, and it is per-role.** Six reviewer runs found the real defect at every level, but `low` under-graded it once; six scout runs and six worker runs kept their correctness at every level. `scout` and `worker` to `low` and `reviewer` to `medium` is worth about 29% of a ticket-sized pass, with no correctness loss attributable to thinking.
- **A green gate proves self-consistency, not correctness.** The worker wrote tests asserting its own interpretation, so all six runs passed the suite; only an independent oracle exposed that three of six silently reported zero counts on an unreachable database. The ticket never specified that contract. In an agent-implemented flow, error-path ambiguity is resolved silently and then locked in by generated tests, which makes specifying it in `/to-spec` or `/to-tickets` more valuable than any further tuning.

The inherited `high` thinking level was not changed: that is the operator's setting, and the extension does not override it.

Recommendation: **keep `pi-subagents` as the default for now.** The active extension's breadth (background work, parallel review, research with sources) is still doing real work in this operator's flow, and Durable's measured advantage is cost plus recovery discipline, not features. Continue Durable as the narrow blocking delegator. The case for switching defaults would rest on cost and predictability, and it is not established yet.

Highest-value next steps, in order:

1. Test reviewer grading: run several reviewers over one diff with a known-correct severity, and see whether a normalised rubric reduces the High/Medium and Spec Pass/Fail spread.
2. Run the same paired design on `scout` and `worker` to test whether `low` thinking holds up for retrieval and implementation, where 25-47% is available and no grading decision is at stake.
3. Try the bounded-context guidance against a large production repository to see whether the 22% cost reduction holds when discovery is harder.
4. Decide the thinking-level policy per agent definition, since output tokens are a large share of cost and `high` is inherited today.
5. Revisit concurrency only if a trustworthy read-only signal appears in Pi's tool API; otherwise record the trade-off permanently.
