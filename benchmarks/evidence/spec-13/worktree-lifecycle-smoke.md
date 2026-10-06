# Worktree lifecycle host smoke

Run the deterministic real-Pi lifecycle scenarios with:

```sh
node --experimental-strip-types --test test/worktree-host-lifecycle.test.ts
```

Each scenario creates a disposable git repository and a real Pi `createAgentSession`; the faux provider requests actual host tools through the public Delegation, Follow-up, and management tools.

Observed assertions:

- An allowance-paused child keeps its worktree through explicit Continuation. The completed pre-pause write remains exactly once in the checkout, the continued write appears there, and neither appears in the parent.
- A retained-context Follow-up has a distinct Run linked to the original Conversation and reads the committed checkout value before writing only in that checkout.
- Deleting or replacing the retained checkout with a symlink makes Follow-up fail with an actionable workspace error before child generation. It does not fall back to the parent directory.
- Reopening an interrupted child leaves it stopped. Unapproved Recovery invokes no child adapters; approved Recovery uses the new host permission hook, honors a denied write, and does not replay the completed write or uncertain bash call.
- Cancellation reaches a held in-flight bash tool. Retrieval leaves the Run aborted and does not restart it.

The scenarios use disposable fixtures and do not modify an operator checkout or extension configuration.
