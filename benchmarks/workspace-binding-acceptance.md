# Worktree host-tool binding acceptance

Ticket #14 is exercised through the public `subagent` Delegation tool in a real Pi `createAgentSession()` with the installed host `bash` and `read` tools. Run the focused smoke with:

```sh
node --experimental-strip-types --test test/worktree-host-binding.test.ts
```

The scripted child runs `pwd` and `git rev-parse --show-toplevel`; both return its assigned worktree path. It reads the literal committed value `committed base value\n` even though the parent changed that tracked file to `parent-only modification\n`. A relative read of the parent-only untracked file errors. An explicit absolute read of that same file returns `parent-only untracked value\n`, preserving the existing host permission semantics. The parent files remain unchanged.

A host permission listener registered before the Sub-agent extension observes the nested shell command with the checkout-scoped `cd` and relative reads with absolute checkout paths. This confirms binding happens before `ctx.executeTool()` and before host validation and permission hooks. The child loadout omits unbound search tools. Pi's installed SDK has no per-call cwd option on `ExtensionToolContext.executeTool`; the bridge therefore transforms only verified built-in `bash` and `read` arguments before making the normal nested call. It does not call tool implementations directly or change the process directory. An extension tool with no filesystem dependence may opt in by setting its namespace instructions to the exported `WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION` value; otherwise it remains unavailable in a worktree run.

Validation on the ticket branch: `npm test` passed 207/207 tests and `npm run typecheck` passed.
