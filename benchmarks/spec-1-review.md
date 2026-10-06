# Spec 1 review record

This record captures the standards and spec reviews of the supervised delegation integration and how each finding was resolved.

## Review points

- Baseline: `4b54369`
- Integration reviewed: `57aec576c49312843b496da80348e0a5b0c59454`
- Review-fix commit: `0f87b869a15e6710af8cac620f7ef03b3e3d41d7`

## Standards review

No hard documented-standard violations were found. One maintainability heuristic identified duplicated field-by-field usage aggregation in `runtime.ts` and `usage.ts`, including nested cost fields. Keeping a shared helper avoids accounting paths drifting when usage fields change.

**Resolution:** `sumUsage` now lives in `usage.ts` and is used by both runtime model accounting and grouped result accounting. Empty model maps still produce zero totals, while `usageForRuns` remains undefined when there is no reportable run usage. Delta and deduplication behavior is unchanged. Regression coverage includes every token field, nested cost fields, and empty input.

## Spec review

One P2 finding identified an overly broad parent tool guard during child workspace ownership. The guard rejected session-native task controls and read-only inspection even though those operations do not write to the child-owned workspace. This conflicted with the spec's workspace-scoped coordination boundary and its requirement that the parent remain able to reason, inspect, and steer after a non-blocking start.

**Resolution:** The parent may use tools whose public Pi metadata declares `readOnlyHint: true`, the known optional read tools, and host-only `get_tasks`/`set_tasks` controls. Unknown or effectful parent calls remain blocked while workspace ownership is active. The Tasks controls are handled by local policy; the implementation adds no Tasks import, registration, bridge, or child exposure. Installed-host regression coverage verifies those permitted calls and confirms a parent file write is rejected without a file effect.

## Validation and disposition

- Final review findings: 1 standards heuristic and 1 P2 spec finding; both resolved.
- Remaining findings: 0.
- Full suite: 189 passed, 0 failed.
- Focused installed-host/accounting/combined/notification suite: 26 passed, 0 failed.
- Final usage and supervision tests: 7 passed, 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

These results describe the reviewed findings and recorded checks; they are not a claim that the change is free of all possible defects.
