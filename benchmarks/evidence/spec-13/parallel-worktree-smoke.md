# Parallel worktree host smoke

Run the deterministic real-Pi host scenario with:

```sh
node --experimental-strip-types --test test/worktree-host-parallel.test.ts
```

The test creates a disposable git repository and opens a real `createAgentSession` with the Durable extension loaded. An offline faux provider requests two children through the public `subagent` group tool. A workspace-independent fixture tool holds both children until each reaches the barrier; after release, the children invoke Pi's actual `bash`, `read`, and `write` tools.

Observed assertions:

- Both children were held at the barrier concurrently.
- Each shell reported its own worktree for both `pwd` and `git rev-parse --show-toplevel`; the group result recorded those same two distinct paths.
- Both relative reads returned the committed literal `committed shared value\n`, despite the parent modifying a different tracked file and adding an untracked file.
- The red checkout contained exactly `RED_VALUE\n`; the blue checkout contained exactly `BLUE_VALUE\n`.
- The parent retained `dirty parent value\n` and `parent-only value\n`. Its relative read of the parent-only file succeeded while both children were held, and a read after completion still returned `dirty parent value\n`.
- The parent's file list was unchanged.

This smoke uses a scripted model provider for determinism and the installed Pi host/tool path for delegated execution; it does not modify an operator checkout or extension configuration.
