# Source-namespaced string Ticket id

The `TicketId` was a positive integer, which fit the local folder source but not Linear, whose only stable key is a string UUID. We changed `TicketId` to a branded string that carries its source as a namespace (`folder:42`, `linear:<uuid>`), so every id is globally unique across sources and a Ticket's origin travels with its identity, not in a separate field.

## Considered options

- A separate `source` field on `Ticket` — rejected. The field can drift from the id, and it adds an attribute the domain would be tempted to branch on.
- A synthetic integer mapped from the Linear identifier — rejected. The Linear `identifier` (`ENG-123`) is not stable across a team move; only the UUID is stable.

## Consequences

- The domain never branches on source. Only a routing (combined) source parses the id namespace to decide where a write goes.
- The folder source keeps numeric filenames and numeric `blockedBy` on disk. It applies the `folder:` namespace in memory only, so there is no on-disk migration.

## The folder part

Standard ticket-writing skills group tickets in one folder per feature, with numbers that restart in each folder. A numeric filename prefix alone would give two tickets the same identity, so the folder identity also holds the ticket's folder below the tickets folder: `folder:<folder>/<number>`, such as `folder:auth/1` for `auth/01-login.md`, with `/` between the segments of a nested folder. A `done` segment is not part of the identity, so a ticket keeps its identity when it moves into the `done/` of its folder. A ticket directly in the tickets folder has no folder part and keeps the identity `folder:<number>` it had before, so its Ledger records and branches stay valid.

- The number is the numeric value of the filename prefix, so `01` and `1` are the same ticket. The slug of the filename is not part of the identity; a moved or renumbered file is a new ticket.
- A blocker number, in a `blockedBy` field or a "Blocked by" line, names a ticket of the same folder.
- The branch of a Ticket Worktree, and so its directory, is named from the identity with every character other than a letter, a digit, `_`, or `-` replaced by `-`: `folder:auth/1` gives `ticket-folder-auth-1`. Folder names that differ only in such characters can give the same branch.
