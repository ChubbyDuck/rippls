# Linear as a ticket source

We added Linear as a second Source behind the existing `TicketSource` port, so the engine processes Linear issues with no domain change: the source converts a Linear issue into a `Ticket` on read, and converts Ticket changes into Linear writes on write. Linear has no custom-field API and no atomic claim, so the mapping uses the fields Linear does model, plus grouped labels for the rest, and a race-tolerant claim. The connection uses `@linear/sdk` with raw GraphQL and Effect `Schema` decoders, authenticated by a personal API key in the `Authorization` header verbatim (no `Bearer`).

## Mapping

- Identity: the issue UUID (stable). The `identifier` (`ENG-123`) is display-only.
- Native fields: `title`, `description` → body, Linear project → Project (slugified to a branch-safe string), issue relations → `blockedBy`/`blocks` (blockers from `inverseRelations(type: blocks)`, incomplete only).
- No native slot: `kind` and the `task` `hitl` are grouped labels. An issue without exactly one `kind` label is not a valid Ticket, so the source skips it.
- Status by `WorkflowState.type`, per team: `triage`/`backlog` → `open`, `unstarted` → `ready-for-agent`, `started` → `claimed`, `completed` → `done`, `canceled`/`duplicate` → `resolved`. `blocked` is derived from `blockedBy`; `claiming` is transient.

## Reads and writes

- The pull is team-scoped (config `teamId`). The `--project` flag narrows it to one Linear project by slug. The source surfaces only `unstarted` and `started` issues, so a human moves an issue to Todo to make it ready — the readiness gate needs no extra label.
- Claim sets assignee = viewer and the first `started` state, then re-reads to confirm. A lost race fails the save. `claimedBy` (the `RunnerId`) is not stored durably on Linear.
- Complete → `completed` state; release → unassign + `unstarted`; escalate → unassign + `unstarted` + labels `hitl:yes` and `kind:task`. Unblock needs no write, because Linear derives blockers from live relations.

## Consequences

- This deviates from the lalph reference on three points: we key by UUID (not `identifier`), we pin a team (not a project), and we do not filter by assignee on the ready query.
- Metadata (viewer, per-team states, labels, projects) is cached. Each poll runs one filtered query ordered by `createdAt`, and honors the `X-RateLimit-*` headers.
- Phase one is a dedicated switch — a tagged `source` value in config and on the CLI selects the folder source or the Linear source for a run. A combined source that reads both and routes writes by the id namespace is deferred.
