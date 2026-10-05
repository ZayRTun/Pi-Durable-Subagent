# Durable smoke-test fixes

## Model-facing metadata

Run records already held the selected model, thinking, elapsed duration, tokens, and cost.
The tool's model-facing text omitted them. `index.ts` now emits a compact line before each answer.
The TUI renderer is unchanged.

The real Pi SDK regression test initially failed with `selected model must be visible to the caller`.
A parent-run live delegation now returned:

```text
model opencode-go/deepseek-v4.1-flash · thinking low · 7s · 5.5k tok / ~$0.0006 billed this call
```

Usage reported to Pi is distinct from additional provider requests. A terminal retrieval whose prior
usage is already present on the active branch says `recorded usage (retrieved; not newly billed)`
and returns no additional usage. If a branch change removes the prior delivery, the same historical
usage can be reported on that branch. Its metadata now says `reported on this branch; no new model work`.
A real SDK branch-change test reproduced the misleading earlier label before the correction.

Approved recovery is tested separately. The returned usage equals cumulative usage minus the
previously delivered partial usage, and the metadata distinguishes the increment from the recorded total.

## Multi-step accounting regression

Parent verification discovered that `usageToReport` recognized only single-run `details.id` results,
not runs delivered inside `details.steps`. Retrieving a completed task or chain step therefore
reported its stored usage again. No additional provider request was necessary to trigger this defect.

Both real SDK reproductions failed with:

```text
stored multi-step usage must not be reported again
+ { totalTokens: 2366, ... }
- undefined
```

`usage.ts` now recognizes delivered steps. Both tests pass and verify undefined additional usage,
byte-identical records, and only the two scripted parent calls during retrieval.

## Scout instruction precedence

The original definition's detailed process and eight-section handoff conflicted with explicit
short-answer tasks. The revised definition makes task-specific scope, output format, and length
constraints take precedence. The handoff remains a default. The tools and read-only restrictions
are unchanged. Instructions do not constitute a read-only sandbox.

A controlled comparison used the same real model, thinking level, disposable files, and scripted
parent, varying only the definition. These are single observations, not reliability estimates.

| Probe | Baseline | Revised | Interpretation |
|---|---|---|---|
| One sentence | 166 words, 12 sentences | 21 words, one sentence | Format failure reproduced and corrected in this pair |
| Under 200 words | 190 words | 79 words | Both passed the length limit in this pair |
| Default handoff | Not measured in this pair | 443 words, eight sections | Default structure remains available |

The under-200 probe asked for one descriptor, but both arms read README.md and package.json.
That file-scope constraint was not met. The evidence does not establish general scope obedience.
Read-tool events alone cannot audit shell-mediated reads; raw shell commands must also be inspected.

A separate parent-run probe repeated the original smoke-test task with README.md and package.json
both present. The revised scout returned 125 words, read exactly those two files through `read`,
and ran only `pwd && ls -la` through `bash`. It did not read source files. An initial parent assertion
requiring no shell calls failed; that assertion was stricter than the task, which allowed inspection.
The directory-listing command is retained in the evidence rather than hidden.

## Evidence and cost

- `scout-obedience-evidence.json` retains the implementation agent's historical comparison outputs,
  captured before the harness gained `resultText` and fixture cleanup. Its original output schema is
  preserved; those measurements were not regenerated or rewritten to look current.
- `scout-original-task-evidence.json` records the parent-run original-task probe, including the new
  model-facing metadata text and raw tool events.
- `scout-obedience.mjs` is the rerunnable live harness. It reports length metrics and raw tool events,
  not a complete filesystem-scope verdict. It restores its environment and removes the fixture after
  a completed session.

The implementation agent reported approximately $0.003909 in child-model spend. The parent's
additional original-task delegation recorded $0.000557316. Combined child-model spend is approximately
$0.004466, excluding parent and review sessions. Usage is provider-reported, not independently
reconciled against an invoice. Failed exploratory harness/provider attempts are not correctness passes.

## Verification

- 74 tests pass; typechecking is clean.
- Real SIGKILL acceptance and offline PTY probe pass.
- Metadata, same-branch retrieval, changed-branch retrieval, multi-step retrieval, and approved recovery
  exercise the actual Pi SDK tool path.
- The Laravel workspace remains untouched. Settings and model pools were not modified.

## Changed files

- `index.ts` adds model-facing metadata and truthful retrieval accounting labels.
- `usage.ts` recognizes usage delivered in aggregate step results.
- `test/metadata.test.ts` covers metadata and retrieval with retained or changed branch history.
- `test/metadata-multi-retrieval.test.ts` covers retrieval of task and chain steps.
- `test/pi-recovery.test.ts` checks incremental usage and metadata during approved recovery.
- `../my-agents-backup/scout.md` declares task-specific constraints ahead of default instructions.
- The benchmark script and evidence files record the comparisons and limitations.

## Review limitations

Three OpenAI review launches failed account access before producing a review, including a model
listed in the local authenticated catalog. A fresh DeepSeek review completed instead. It was
context-isolated, not cross-family independent. Its accounting and evidence findings were reproduced
or addressed above. The suggested Process-heading annotation was not added because the precedence
paragraph already covers it and no controlled result justified that extra change.

The scout measurements cover one model and a small sample. The revision improves the tested
formatting but cannot guarantee compliance, and the one-descriptor scope violation remains a known limit.
