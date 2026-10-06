# Spec #13 review resolution

## Standards findings

- No documented coding-standard or ADR conflict was found. Real-host worktree tests now share `test/fixtures/worktree-host.ts` for Git fixture initialization and cleanup.

## Spec findings

- Unsupported workspace capabilities now have an explicit effective-loadout explanation. If a worktree Execution actually attempts a declared unavailable tool, the existing failed Run outcome reports `Task blocked` with the capability name. Detection uses recorded tool-call names; it does not infer task requirements from free-form task text or claim model obedience.
- Workspace paths follow the installed Pi 1.0 normalization contract before resolving relative targets: `@` prefix stripping, tilde expansion, `file://` conversion, Unicode-space normalization, and Windows shell-path normalization. Real-host permission hooks observe the resolved effective targets; absolute paths retain host policy.
- Core workspace tools require the exact `builtin:<tool-name>` source identity. Other `builtin:` extension paths do not make a same-name tool trusted. Real-host coverage also checks that an explicitly workspace-independent extension receives its original arguments and that a parent-disabled tool remains unavailable.
- The parallel aggregate interruption came from replacing the live presentation entries with a detached snapshot after a child's asynchronous retained-worktree preflight. Child closures then updated stale entry objects, leaving pending metadata even after successful Runs. The presentation replacement was removed; the deterministic two-child barrier test asserts successful results and final `run` phases for both members.

## Verification

- `npm test`: 213/213 passed.
- `npm run typecheck`: passed.
- Real-host worktree binding, mutation, search, parallel, and lifecycle checks: 7/7 passed.
- `python3 /tmp/pi-spec13-context/reproduce-parallel.py`: 40/40 passed with eight concurrent invocations.
- Disposable real-Pi host-session coverage verifies shell cwd, relative reads, effective permission-hook targets, blocked unavailable search, and isolated parallel writes without touching operator files or changing extension configuration.
