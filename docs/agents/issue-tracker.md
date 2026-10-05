# Issue tracker

Issues and specs for this standalone extension live in GitHub Issues in `ZayRTun/Pi-Durable-Subagent`. Use the `gh` CLI. Do not publish Durable implementation tickets in the general `ZayRTun/Pi-Agent` configuration repository.

## Current feature

- Parent spec: [Optional deadlines and supervised non-blocking Delegation, #1](https://github.com/ZayRTun/Pi-Durable-Subagent/issues/1).
- Implementation tickets: #2 through #12.
- Initial unblocked ticket: [Make execution deadlines optional, #2](https://github.com/ZayRTun/Pi-Durable-Subagent/issues/2).

These issues were transferred from the previous tracker. The transferred issues retain their history. Use the new identifiers for parent references and blocking edges.

## Conventions

- Apply `ready-for-agent` to approved implementation tickets.
- Use native GitHub blocking relationships and include blocking issue references in ticket bodies.
- Work only on tickets whose blockers are complete.
- Preserve the parent spec when publishing child tickets unless the operator authorizes a parent change.
- Keep the approved production native TUI as the fixed design system. The abandoned browser prototype is not a visual reference.

## Commands

```sh
gh issue list --repo ZayRTun/Pi-Durable-Subagent --state open --label ready-for-agent
gh issue view 1 --repo ZayRTun/Pi-Durable-Subagent --comments
gh issue create --repo ZayRTun/Pi-Durable-Subagent --title "..." --body-file ticket.md --label ready-for-agent
```

The canonical triage labels are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`.
