# Read-only tickets and the Ledger

The Engine used the ticket as its database: it recorded the Claim, the Ticket Status, and escalation by rewriting the ticket. A folder ticket's front matter was rebuilt on every change, so unknown keys were lost, a skill that edited its own ticket competed with the Engine, and the Claim took two separate writes that were not atomic. On exit an Engine released every claimed ticket in scope, including tickets that another Engine had claimed. We decided that Rippls reads a ticket and does not rewrite its content, and that the Engine keeps its own record of Ticket Processing, the Ledger.

## Three homes

What the Engine knows about a ticket has three homes, split by lifetime:

| Fact | Home | Written by |
| --- | --- | --- |
| Description: text, Title, Ticket Kind, HITL, blockers | The ticket | Authors and skills only |
| Transient: Claim, attempts, escalation | The Ledger | The Engine only |
| Done | The repository, as the ticket's position, with the merge; and the Ledger, once the work is merged | The Engine, as a move and a record |

The Engine signals a Source only through operations that do not depend on the ticket's shape: moving a file, and, on Linear, changing the assignee, the workflow state, or a label. It reports each event to the Source, and each Source expresses the event in its own way. The folder Source does nothing for a claimed, a released, or an escalated ticket.

## The Ledger

- The Ledger is a port. It is keyed by ticket identity and holds one record per ticket.
- Its adapter keeps the records in a folder for Rippls inside the Git common directory of the Repository Root (`<git-common-dir>/rippls/ledger/`). Every worktree of the repository shares that directory, it never appears in a merge, and it needs no ignore rule.
- The Ledger is local for every Ticket Source. Linear is not the Ledger.
- A Claim is made by creating its record exclusively (a hard link onto the record's name), so only one caller can succeed. The record names the Engine, the process, and the host, and it gains the Runner when a Runner starts Ticket Processing.
- The Engine claims a ticket when it takes it from the Ticket Stream. Unclaimed means the Ledger holds no Claim on the ticket other than a Stale Claim, and its Source does not see it as claimed (Linear sees a started Issue so), unless this host's Ledger holds a Stale Claim on it.
- The Engine makes the Claim in the Ledger and then reports claimed to the Ticket Source. When that report fails, its writes to the Source may have landed, so the Engine keeps the Claim, does not process the ticket, and takes another one. When it exits, it reports released, which undoes what landed.
- On exit an Engine releases only the Claims it holds. It removes the record of each one only after the Ticket Source accepts its released report; when that report fails, the record stays and becomes a Stale Claim, which a later run replaces.
- When Ticket Processing fails for one of four causes, the Engine records an Escalation with the reason, the attempt count, and the path of the retained Ticket Worktree, releases the Claim, reports escalated to the Ticket Source, and halts. The four causes are a failed Strategy step (a Harness error, its time limit, or a verdict other than pass, after the step's retries), a check command that still fails after its fix attempts, work still uncommitted in the Ticket Worktree after the commit prompt, and a done report that the Ticket Source does not accept. The reason of the Escalation names the cause, and for a failed Strategy the step. The ticket keeps its Ticket Kind and HITL. An escalated ticket is not Eligible, in this Engine run or a later one. The adapter keeps an Escalation in `<git-common-dir>/rippls/ledger/escalations/`, apart from the Claim, so it outlives the release; another escalation of the same ticket raises its attempt count. Since the Escalation is recorded before the Claim is released, an Engine that has just claimed a ticket reads its Escalation again and releases and skips a ticket that another Engine escalated after the poll.
- A human returns an escalated ticket to unattended processing with a Retry (`rippls retry <ticket>`). The command reports retried to the Ticket Source first, since a Source may show the ticket as not ready until it hears it, and then clears the Escalation: the adapter moves its record to `<git-common-dir>/rippls/ledger/cleared/`, so the attempt count is kept and another escalation of the ticket raises it. A retried report that fails leaves the Escalation in place, and the Retry can run again. The next Ticket Processing of the ticket continues in its retained Ticket Worktree, so the earlier work and a human's fixes are kept.
- The Ledger also records done, once the work of a ticket is merged. A ticket is done when its Source sees it as done or the Ledger records it as done; neither fact reverts. The Ledger covers a Project ticket whose move is on the Project branch and has not reached the Repository Root. The adapter keeps done in `<git-common-dir>/rippls/ledger/done/`. An Engine that has just claimed a ticket reads done again, as it reads the Escalation, and releases and skips a ticket that another Engine completed after the poll.
- A Claim is stale when its process no longer runs on this host. A Claim whose process still runs is never stale, and a Claim from another host is never treated as stale, since the Engine cannot see the processes of another host. When the Engine looks for the next ticket and meets a Stale Claim, it replaces it: it turns the stale record into its own Claim with one operation of the Ledger, reports released to the Ticket Source, and then reports claimed in the normal way. Only the Engine that wins the replacement goes on, so a late released never undoes the Claim of another Engine, and a Claim made on the ticket since the Stale Claim was read stays in place. When the released report fails, the Engine keeps its new Claim until it exits, also on a ticket whose Escalation or done it finds since the poll.
- The adapter replaces a Stale Claim with one rename of the new record onto the stale one, so the Ledger holds the Stale Claim or the new Claim at every point of a replace, and never neither. A rename does not tell which record it replaced, so only one caller at a time may make it. A caller enters the replace of a ticket by moving a folder that holds its new Claim to the ticket's name in `<git-common-dir>/rippls/ledger/replacing/`; the move succeeds only when no folder with a Claim is there. Once in, the caller reads the record again, writes the new record when the Stale Claim is still there, and leaves by removing its file, whatever the outcome. A replace that fails leaves the Stale Claim. A caller whose process stops stays in, and the record is the Stale Claim or its new Claim, which is then stale too. Its file is a Claim of a process that no longer runs, so the next caller removes that file, by its own name, and enters. In both cases a later poll replaces the Claim again. A file left by a process on another host is never removed, as a Claim from another host is never stale.

## The Claim is a saga

A Claim spans two systems that share no transaction: the Ledger, and the Ticket Source (on Linear, the assignee and the workflow state). The Engine runs it as a saga. The Ledger is its log, the claimed report its forward step, the released report its compensation, and the replacement of a Stale Claim its recovery. Four rules hold it:

1. **Log first, log last.** The Engine writes a ticket's record in the Ledger before its first write to the Source. The record leaves the Ledger only once the Source is confirmed in an end state: released, escalated, or done.
2. **One write per step.** A record changes in one write of the Ledger, a change of its Engine included. It is never removed and created again.
3. **Guarded, repeatable writes.** Every write to the Source can run again safely, and changes an Issue only while Rippls still holds it: on Linear, an Issue in a started state and assigned to the API-key user.
4. **Recovery.** An Engine that meets the record of a stopped Engine finishes or undoes that saga.

The log needs no step field: each step on the Source can be read back, so recovery reads the Source to learn where the saga stopped.

Rippls accepts these limits of the saga:

- Recovery runs only when an Engine runs again on the same host. Until then, the Issue stays started: unresolved, not lost.
- A deleted Ledger loses its open sagas (see Consequences).
- A saga is local to one host. A Claim from another host is never stale, so its saga waits for that host.
- People see the steps in between: for a moment, Linear shows an Issue started and assigned to Rippls.

## Consequences

- A `claimedBy` field and the claim statuses that earlier Engines wrote into folder tickets are read and ignored. Existing tickets need no migration.
- Two Engines can run on one Repository Root: one never releases or takes the Claims of the other.
- If the Ledger is deleted, its Claims, Escalations, and done records are forgotten and their tickets become Eligible again; an escalated folder ticket is taken again, and so is a done Project ticket whose Project Worktree is not yet merged into the Repository Root. Linear keeps its own signals.
- A Claim left by a killed Engine no longer blocks its ticket on the same host. A Claim left on another host stays until someone removes its record.
