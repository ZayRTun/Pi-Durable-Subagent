# Worktree discovery and search acceptance

Ticket #16 is exercised through the public `subagent` tool in a real Pi `createAgentSession()` using the host `grep`, `find`, and `ls` tools. Run the focused smoke with:

```sh
node --experimental-strip-types --test test/worktree-host-search.test.ts
```

A disposable committed checkout contains `search/evidence.txt` with `CHECKOUT_ONLY_NEEDLE`; its parent has a modified tracked file and an untracked `parent-only.txt`. Explicit relative and omitted scopes for all three tools resolve to the child checkout. Literal results include the committed evidence and exclude the parent-only file. A deliberate absolute `grep` scope still reaches the parent under existing host policy, and a subsequent parent `grep` retains the parent default scope.

The fixture registers an unsupported workspace-sensitive `fffind` extension tool. The child loadout reports it unavailable, a requested call fails visibly, and its implementation is invoked zero times. Tool calls still pass through Pi's normal nested tool path; the test observes effective scope arguments in host `tool_call` events.

Validation on the ticket branch: `npm test` passed 208/208 tests and `npm run typecheck` passed.
