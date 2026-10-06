# Worktree mutation acceptance

Ticket #15 is exercised through the public `subagent` tool in a real Pi session using built-in `write` and `edit` tools. The scripted child edits a committed file, creates a relative file, submits an edit whose old text is absent, and asks Pi to write a path denied by a host `tool_call` hook. It then writes one explicit absolute path to verify existing host semantics.

The test asserts exact child contents, unchanged parent content and file list, no file for the denied write, and no effect from the invalid edit. The permission hook sees relative mutation targets resolved under the assigned worktree; the absolute target remains unchanged. Calls still go through `ctx.executeTool()`, retaining Pi argument validation, hooks, nested events, results, and abort propagation.

Run the focused real-host smoke with:

```sh
node --experimental-strip-types --test test/worktree-host-mutations.test.ts
```

Validation on the ticket branch: `npm test` passed all 208 tests, the focused smoke passed, and `npm run typecheck` passed.
