# Read-only tickets and the Ledger

The Engine used the ticket as its database: it recorded the Claim, the Ticket Status, and escalation by rewriting the ticket. A folder ticket's front matter was rebuilt on every change, so unknown keys were lost, a skill that edited its own ticket competed with the Engine, and the Claim took two separate writes that were not atomic. On exit an Engine released every claimed ticket in scope, including tickets that another Engine had claimed. We decided that Rippls reads a ticket and does not rewrite its content, and that the Engine keeps its own record of Ticket Processing, the Ledger.

## Three homes

What the Engine knows about a ticket has three homes, split by lifetime:

| Fact | Home | Written by |
| --- | --- | --- |
| Description: text, Title, Ticket Kind, HITL, blockers | The ticket | Authors and skills only |
| Transient: Claim, attempts, escalation | The Ledger | The Engine only |
| Done | The repository, as the ticket's position, with the merge | The Engine, as a move |

The Engine signals a Source only through operations that do not depend on the ticket's shape: moving a file, and, on Linear, changing the assignee, the workflow state, or a label. It reports each event to the Source, and each Source expresses the event in its own way. The folder Source does nothing for a claimed, a released, or an escalated ticket.

## The Ledger

- The Ledger is a port. It is keyed by ticket identity and holds one record per ticket.
- Its adapter keeps the records in a folder for Rippls inside the Git common directory of the Repository Root (`<git-common-dir>/rippls/ledger/`). Every worktree of the repository shares that directory, it never appears in a merge, and it needs no ignore rule.
- The Ledger is local for every Ticket Source. Linear is not the Ledger.
- A Claim is made by creating its record exclusively (a hard link onto the record's name), so only one caller can succeed. The record names the Engine, the process, and the host, and it gains the Runner when a Runner starts Ticket Processing.
- The Engine claims a ticket when it takes it from the Ticket Stream. Unclaimed means the Ledger holds no Claim on the ticket other than a Stale Claim.
- On exit an Engine releases only the Claims it holds.
- When a Strategy fails, the Engine records an Escalation with the reason, the attempt count, and the path of the retained Ticket Worktree, releases the Claim, reports escalated to the Ticket Source, and halts. The ticket keeps its Ticket Kind and HITL. An escalated ticket is not Eligible, in this Engine run or a later one. The adapter keeps an Escalation in `<git-common-dir>/rippls/ledger/escalations/`, apart from the Claim, so it outlives the release; another escalation of the same ticket raises its attempt count.
- A Claim is stale when its process no longer runs on this host. A Claim whose process still runs is never stale, and a Claim from another host is never treated as stale, since the Engine cannot see the processes of another host. When the Engine looks for the next ticket and meets a stale Claim, it replaces it: it reports released to the Ticket Source, removes the stale record, and then claims the ticket in the normal way. The record is moved aside under a name of its own, which only one caller can do, and is removed only when it is that stale Claim; a Claim that another Engine made in the meantime is put back.

## Consequences

- A `claimedBy` field and the claim statuses that earlier Engines wrote into folder tickets are read and ignored. Existing tickets need no migration.
- Two Engines can run on one Repository Root: one never releases or takes the Claims of the other.
- If the Ledger is deleted, its Claims and Escalations are forgotten and their tickets become Eligible again; an escalated folder ticket is taken again. Linear keeps its own signals.
- A Claim left by a killed Engine no longer blocks its ticket on the same host. A Claim left on another host stays until someone removes its record.
