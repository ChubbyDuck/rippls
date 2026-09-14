# Source-namespaced string Ticket id

The `TicketId` was a positive integer, which fit the local folder source but not Linear, whose only stable key is a string UUID. We changed `TicketId` to a branded string that carries its source as a namespace (`folder:42`, `linear:<uuid>`), so every id is globally unique across sources and a Ticket's origin travels with its identity, not in a separate field.

## Considered options

- A separate `source` field on `Ticket` — rejected. The field can drift from the id, and it adds an attribute the domain would be tempted to branch on.
- A synthetic integer mapped from the Linear identifier — rejected. The Linear `identifier` (`ENG-123`) is not stable across a team move; only the UUID is stable.

## Consequences

- The domain never branches on source. Only a routing (combined) source parses the id namespace to decide where a write goes.
- The folder source keeps numeric filenames and numeric `blockedBy` on disk. It applies the `folder:` namespace in memory only, so there is no on-disk migration.
- A query sort can no longer assume a numeric, orderable id, so the sort carries a direction only and each source orders by its own natural key.
