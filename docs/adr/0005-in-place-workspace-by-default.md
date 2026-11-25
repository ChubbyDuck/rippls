# The in-place Workspace by default

Rippls was built around Ticket Worktrees: each Ticket got its own worktree and branch, installed dependencies, and merged into the Repository Root with a merge commit. The ticket loop that Rippls replaces works in place: each session edits the current checkout and commits on the current branch. We made in place the default Workspace and Ticket Worktrees the opt-in. Rippls with no config should behave like the loop the developer trusts, and many repositories assume their main checkout: an `.env` that Git ignores, fixed ports, an end-to-end suite, a database set up for that folder.

In place is an adapter of the Worktree Manager port, not a branch in Ticket Processing. Preparing a ticket returns the Repository Root, merge and close does nothing, and the clean check ignores untracked files under the tickets folder.

## Considered options

- **Ticket Worktrees by default, merged into the current branch.** Rejected as the default. It costs a dependency install and a merge commit for every ticket, and a repository whose setup lives outside Git behaves differently in a worktree. It stays as the mode for a Concurrency above one.
- **In place as a separate code path in Ticket Processing.** Rejected. An adapter keeps one lifecycle for both Workspaces, and the use-case tests cover both.

## Consequences

- In place allows a Concurrency of one. A higher Concurrency with in place is a config error.
- The Engine checks for a clean Repository Root before each ticket. A dirty tree halts a Drain and makes a Watch wait for the next poll, so the developer's unfinished work never enters an Agent's commit.
- An Escalation in place has no worktree to keep. It holds the session of the Agent that failed, and a Retry leaves the tree as it is.
- A Project gives no Project Worktree in place: all work lands on the current branch. A Project still scopes a run and picks a check command override.
- The done move is a commit on the current branch, made by the Engine after the session, or a move on the filesystem alone when Git ignores the ticket.
- A Watch in place shares the developer's checkout. An edit made while a session runs can end up in its commit. Ticket Worktrees are the mode for watching a repository the developer is editing.
