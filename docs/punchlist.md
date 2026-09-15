# Truss v1 gauntlet punchlist

Baseline tag: `truss-baseline` - review branch: `review/truss-v1` - landing mode: worktree-default.

| Wave | Piece | Status | Attempts | Notes |
|---|---|---|---|---|
| 1 | server-core | passed | 1 | Merged (commit 0f53ba9). Critic: 28 tests + 65-check script pass. Minor: reveal passes `/select,` and path as separate args; startServer returns extra ctx/server. |
| 1 | formula-engine | passed | 1 | Merged (commit 55a6376). Critic: 69 tests + 74 spot checks pass. Minor: very deep nested formula could overflow stack; ponytail notes on whole-row/col external ranges (#REF!) and linear whole-column checks. |
| 2 | ui-shell | passed | 2 | Merged (commit 37c4a36, merge 1ea22cb). Critic: 19/19 Playwright ui-shell, 28/28 server-core, 69/69 formula-engine pass; 17 extra sanitizer attacks blocked; 300-module sidebar renders in 29-34 ms. Attempt 1 failed (binary-looking sanitize.js regex, clipped labels/emoji), fixed in attempt 2. Note: worker-based module existence probe keeps 404s out of the console (judged legitimate). |
| 2 | scripts-server | passed | 1 | Merged (commit 7dc4888, merge d6c9834). Critic: 18/18 scripts-server, 28/28 server-core, 69/69 formula-engine, 2/2 Playwright pass; cancel/timeout kill full process trees, injection filenames inert, output capped at 1 MB, startup recovery marks runs failed. Minor: attachment-copy fixtures pass filenames to nested powershell -Command; tests/scripts-server/helpers.js reuses server-core helpers. |
| 3 | database | pending | - | |
| 3 | sheets | pending | - | |
| 3 | notebooks | pending | - | |
| 4 | database-relations-io | pending | - | |
| 4 | scripts-ui | pending | - | |

## Open follow-ups

- Custom formula list to be supplied by the user (goes in `web/lib/formula/custom.js`).
- Built-in viewers for images/documents (currently opened in external apps).
