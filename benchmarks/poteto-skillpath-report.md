# Poteto-agent pinned skill source — report

Local operator-definition fix in `agent/my-agents-backup/poteto-agent.md`, plus one bounded live
delegation proving the child reads the pinned installed skill and nothing else. Not an OS sandbox.
Costs are provider-reported, not independently reconciled.

## Baseline ambiguity

The pre-fix definition said the skill "ships with the `@casualjim/pi-pstack` package under
`skills/poteto-mode/`" and to "locate it with a bounded search when the task does not name the
path." After `~/code/pi-extensions` was deleted, that wording still invites a search for another
installation. The deleted path was not probed live. Snapshot: `poteto-skillpath-baseline.md`.

## Fix

`agent/my-agents-backup/poteto-agent.md` now names the exact installed source:
`/Users/zayar/.pi/agent/npm/node_modules/@casualjim/pi-pstack/skills/poteto-mode/SKILL.md`, names the
sibling `principle-*/SKILL.md` leaf directory, forbids discovery of or substitution with an alternate
installation, and requires reporting inability to continue when the pinned file is missing. No
loader, extension, settings, or Durable code changed. Diff: `poteto-skillpath-definition.diff`.

## Live evidence

Harness `poteto-skillpath-live.mjs`, one real child delegation, scripted local faux parent,
disposable fixture with exactly `README.md` and `package.json`, child model
`opencode-go/deepseek-v4.1-flash`, thinking `medium` from the unchanged operator definition.
Raw record: `poteto-skillpath-evidence.json`.

Task: read the pinned poteto-mode SKILL.md in full, then inspect only README.md and package.json,
no shell, no edits, no delegation, answer at most 150 words, cite a principle only if it shaped a decision.

Result, one child run `3d74d5462c1325bba8ee3426ebfab258`:

| Check | Observed |
|---|---|
| Status | succeeded |
| Exact pinned SKILL.md read | yes |
| Pinned-dir skill reads | `poteto-mode/SKILL.md`, `principle-guard-the-context-window/SKILL.md` |
| Other skill installations read | none |
| Project files read | `README.md`, `package.json` only |
| Out-of-scope reads | none |
| Shell commands | zero |
| Edits/writes | none |
| Other tools | none |
| Answer length | 112 words (limit 150) |
| Principle cited | Guard the Context Window, tied to a stated decision |
| Child model / thinking | flash / medium |
| Child cost (parent faux, zero) | $0.001745784 |

The child read the pinned `SKILL.md` by absolute path first, then only the two named workspace files, then one sibling principle leaf it applied. Raw tool events are the four `read` calls; no `bash`, `edit`, `write`, or `subagent` event appeared.

## Limitations

- **n = 1.** One model and thinking level. This is a single observation, not a reliability estimate.
- **`set_tasks` is still absent.** The pinned SKILL.md requires starting multi-step work with
  `set_tasks`, but no such tool is bridged or callable. The child did not call it and did not claim
  to. No fake compliance is asserted; this remains an unresolved capability gap in Durable.
- The scripted parent is faux and pins the child model per call; thinking `medium` comes from the
  operator definition. Behavior outside this fixture is unverified.
- `ls`, `fffind`, `ffgrep`, and `fetch_content` were unavailable in the harness, so their absence is
  a fixture property, not proof the child would ignore them.
- Read paths and tool events are evidence, not a filesystem-access audit. The absence of a `bash`
  event means the child issued no `bash` tool call; it is not an OS-level sandbox guarantee.
- The call was live and potentially billable; no second call was made because the first passed.

## Files

- Changed: `agent/my-agents-backup/poteto-agent.md`
- New evidence: `poteto-skillpath-baseline.md`, `poteto-skillpath-definition.diff`,
  `poteto-skillpath-live.mjs`, `poteto-skillpath-evidence.json`, `poteto-skillpath-report.md`
