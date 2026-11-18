# Linear as a ticket source

We added Linear as a second Source behind the existing `TicketSource` port, so the engine processes Linear issues with no domain change: the source converts a Linear issue into a `Ticket` on read, and converts Ticket changes into Linear writes on write. Linear has no custom-field API and no atomic claim, so the mapping uses the fields Linear does model, plus grouped labels for the rest, and a race-tolerant claim. The connection uses `@linear/sdk` with raw GraphQL and Effect `Schema` decoders, authenticated by a personal API key in the `Authorization` header verbatim (no `Bearer`).

## Mapping

- Identity: the issue UUID (stable). The `identifier` (`ENG-123`) is display-only.
- Native fields: `title`, `description` → body, Linear project → Project (slugified to a branch-safe string), issue relations → `blockedBy` (blockers from `inverseRelations(type: blocks)`).
- No native slot: `kind` and `hitl` are grouped labels, and both are hints. An issue without exactly one valid `kind` label has the default Ticket Kind from config. Its HITL is the `hitl` label, else the HITL its stated `kind` implies, else yes. Linear has no readiness marker.
- A Ticket stores no status. The source sees an issue in a `completed` state as done; its workflow state means nothing else to the Ticket.

## Reads and writes

- The pull is team-scoped (config `teamId`). The `--project` flag narrows it to one Linear project by slug. The source offers only `unstarted` issues for processing, so a human moves an issue to Todo to make it ready — the readiness gate needs no extra label. An issue in a `started` state is already claimed on Linear, so it is not offered; a read by identity still finds it, so the Engine can complete the issue it claimed.
- The Claim lives in the local Ledger (ADR-0004), not on Linear. The Engine reports it to the source: claimed sets assignee = viewer and the first `started` state, then re-reads to confirm. A lost race fails the report, and the Engine releases the Claim in the Ledger and takes another ticket. Released unassigns the issue and moves it to the first `unstarted` state.
- Complete → `completed` state. Unblock needs no write, because Linear derives blockers from live relations.
- The Escalation lives in the local Ledger (ADR-0004). The Engine reports escalated to the source, which unassigns the issue, moves it to the first `unstarted` state, and adds the `needs-human` label. It no longer changes the `kind` or `hitl` labels, so the issue still describes the work. The source reads an issue with `needs-human` as HITL yes, so it is not Eligible while the label stays. When the team has no `needs-human` label, the source logs a warning and the report still succeeds, because the Ledger holds the Escalation.

## Consequences

- This deviates from the lalph reference on three points: we key by UUID (not `identifier`), we pin a team (not a project), and we do not filter by assignee on the ready query.
- Metadata (viewer, per-team states, labels, projects) is cached. Each poll runs one filtered query ordered by `createdAt`, and honors the `X-RateLimit-*` headers.
- Phase one is a dedicated switch — a tagged `source` value in config and on the CLI selects the folder source or the Linear source for a run. A combined source that reads both and routes writes by the id namespace is deferred.
