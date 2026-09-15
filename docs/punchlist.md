# Truss v1 gauntlet punchlist

Baseline tag: `truss-baseline` - review branch: `review/truss-v1` - landing mode: worktree-default.

| Wave | Piece | Status | Attempts | Notes |
|---|---|---|---|---|
| 1 | server-core | passed | 1 | Merged (commit 0f53ba9). Critic: 28 tests + 65-check script pass. Minor: reveal passes `/select,` and path as separate args; startServer returns extra ctx/server. |
| 1 | formula-engine | passed | 1 | Merged (commit 55a6376). Critic: 69 tests + 74 spot checks pass. Minor: very deep nested formula could overflow stack; ponytail notes on whole-row/col external ranges (#REF!) and linear whole-column checks. |
| 2 | ui-shell | pending | - | |
| 2 | scripts-server | pending | - | |
| 3 | database | pending | - | |
| 3 | sheets | pending | - | |
| 3 | notebooks | pending | - | |
| 4 | database-relations-io | pending | - | |
| 4 | scripts-ui | pending | - | |

## Open follow-ups

- Custom formula list to be supplied by the user (goes in `web/lib/formula/custom.js`).
- Built-in viewers for images/documents (currently opened in external apps).
