# Rippls

Language for an opinionated ticket workflow engine: uniform Tickets, a shared lifecycle,
and reusable Strategies for performing the work.

## Participants

**Engine**:
An identified coordinator of named Runners that process Tickets from a Ticket Stream.
An Engine is bound to one Repository Root.
_Avoid_: Harness, loop, orchestrator, worker pool

**Runner**:
A named worker belonging to one Engine, with a stable identity across successive Tickets.
A Runner hosts successive Agents during Ticket Processing.
_Avoid_: Agent, ticket execution, worker

**Harness**:
A reusable coding integration, such as Claude Code, Codex, Cursor, or OpenCode, that
runs a selected Model on instructions from a Strategy.
_Avoid_: Agent, Model, Runner

**Agent**:
A running instance of a Harness's Model on a Runner. Each Harness invocation creates
a new Agent, including a Step's repeated attempts.
_Avoid_: Harness, Model, Runner

**Model**:
The language model used by a Harness for an Agent's execution.
_Avoid_: Agent, Harness

## Tickets

**Ticket**:
A uniform unit of work with a source-scoped identity, Title, Ticket Kind, HITL, body,
blocking relations, and an optional Project. It needs only an identity and text: the
rest are hints with fallbacks. It stores no Ticket Status; its Ticket Status is derived.
_Avoid_: Issue, task (the noun), job

**Ticket Kind**:
The class of work a Ticket represents: implementation, research, prototype, grilling,
or task. A Kind describes the work; a Strategy describes how to perform it.
_Avoid_: Type, category, Strategy

**HITL**:
Whether a human must be in the loop for a Ticket: yes or no. It is the first that the
Ticket states of a HITL, a Marker, and a Ticket Kind that implies one; otherwise yes,
unless config changes the fallback. A default Ticket Kind implies nothing.
_Avoid_: Human review, interactive, AFK

**Marker**:
A readiness word a Ticket may state: `ready-for-agent` means HITL no, and
`ready-for-human` means HITL yes. It is read only for that.
_Avoid_: Status, label, triage state

**Ticket Status**:
A Ticket's position in its lifecycle, derived from the Ticket, the Ledger, and done,
or unreadable for a ticket that its Source cannot read: a file whose name has no
numeric prefix, front matter that cannot be parsed, an invalid hint, or a file that
cannot be read from disk. A folder that cannot be read is reported as unreadable too. An unreadable
ticket is no Ticket, so no other value applies to it. The values are unreadable, done,
escalated, claimed, not ready, blocked, and eligible. When several apply, the first in
that order is the Ticket Status. Claimed means not Unclaimed; not
ready means HITL yes; eligible means Eligible. A `status` value
in a ticket file is not the Ticket Status; it is read only as a Marker.
_Avoid_: State, phase

**Project**:
The optional named scope grouping related Tickets whose work accumulates in a Project
Worktree.
_Avoid_: Repository Root, repo, app, workspace

**Title**:
The short human-readable name of a Ticket.
_Avoid_: Summary, subject

## Processing

**Ticket Processing**:
The shared lifecycle a Runner carries out for one Ticket: claim, apply a Strategy,
run the check command, make sure the work is committed, then record completion or
escalate to a human. It owns claiming, the check, the commit, completion, and
escalation across Strategies.
_Avoid_: Runner, run, execution, loop

**Claim**:
The exclusive assignment of a Ticket to an Engine, recorded in the Ledger. It names
the Engine, its process, and its host, and gains the Runner when a Runner starts
Ticket Processing.
_Avoid_: Lock, take, checkout

**Stale Claim**:
A Claim whose process no longer runs on this host. A Claim from another host is
never stale. The Engine replaces a Stale Claim when it takes the ticket, which
counts as a release for the Source. Only the Engine that wins the removal of its
record reports that release. An Engine that cannot report the release of its own
Claim on exit leaves its record, which is then a Stale Claim.
_Avoid_: Dead lock, orphan, abandoned Claim

**Escalation**:
The Ledger's record that a Ticket needs a human because its Ticket Processing
failed. It holds the reason, the attempt count, and the path of the retained Ticket
Worktree. The Engine does not change the Ticket's Kind or HITL. An escalated Ticket
is not Eligible until a human clears its Escalation with a Retry.
_Avoid_: HITL raise, failure, human task

**Retry**:
A human's return of an escalated Ticket to unattended processing. It clears the
Escalation in the Ledger, keeps its attempt count, and is reported to the Source as
retried. The Ticket's next Ticket Processing continues in its retained Ticket Worktree.
_Avoid_: Reset, requeue, resume

**Ledger**:
The Engine's own record of Ticket Processing, keyed by ticket identity: Claims,
Escalations, and done. It is local to the Repository Root for every Source; a Source is never
the Ledger.
_Avoid_: Database, store, registry

**Strategy**:
A named, reusable procedure for carrying out a Ticket's work through a Harness and
returning an outcome: a list of Steps from config, run in order in one Ticket
Worktree. A failed Step fails the Strategy, and no further Step runs. Each Ticket
Kind has one configured Strategy, named after it.
_Avoid_: Handler, workflow, prompt

**Step**:
One prompt of a Strategy that the Engine sends to the Harness, with an optional prompt
per Harness, model demand, time limit, and retry count. A Step fails on a Harness
error or its time limit, and a failed Step runs again up to its retry count before
it fails the Strategy.
_Avoid_: Stage, slash command

**Verdict step**:
A Step that judges the work. The Engine appends the pass and fail signals to its
prompt and reads the signal back; any outcome other than the pass signal fails it.
_Avoid_: Gate, review

**Check command**:
The repository's own command that the Engine runs in the Ticket Worktree, through the
Worktree Manager and within a time limit, after the Strategy succeeds. Exit code zero
passes; any other exit code, or the time limit, fails the check. A Project may have
its own check command. With no check command, the check is skipped.
_Avoid_: Verify script, test command, gate

**Fix prompt**:
The prompt the Engine sends to the Harness after a failed check, with the end of the
check command's output, so that an Agent can fix the work before the check runs
again.
_Avoid_: Retry, repair prompt

**Fix attempts**:
How many times the Engine sends the fix prompt and runs the check command again
before a failed check escalates the Ticket. One unless config sets it.
_Avoid_: Retries, attempt count

**Strategy Selector**:
The selection policy that determines which Strategy applies to a Ticket.
_Avoid_: Strategy Repository

**Harness Selector**:
The selection policy that determines which Harness to use for Ticket Processing.
Harness selection is independent of Runner identity.
_Avoid_: Agent Repository, Harness Repository

**Spawn**:
An Engine creating a Runner with a unique identity.
_Avoid_: Fork, allocate, start worker

**Concurrency**:
The number of Runners an Engine keeps available to process Tickets in parallel.
_Avoid_: Parallelism, pool size, workers

**Limit**:
The maximum number of Tickets an Engine run takes from the Ticket Stream, regardless
of how many complete successfully.
_Avoid_: Queue, batch, quota

**Idle**:
An Engine's condition when no Ticket Processing is in progress and no Eligible Ticket
is available.

## Worktrees

**Repository Root**:
The Git repository an Engine is bound to for one run.
_Avoid_: Project, CBD, checkout, cwd

**Project Worktree**:
The stable worktree in which a Project's successful ticket work accumulates.
It remains for later Tickets and is merged into the Repository Root by a human.
_Avoid_: Ticket Worktree, checkout, branch

**Ticket Worktree**:
The temporary worktree in which all Agents for one Ticket perform their work.
It is merged and closed after success, retained after escalation to a human, and
reused after a Retry.
_Avoid_: Project Worktree, per-prompt worktree

**Worktree Manager**:
The service responsible for preparing Project Worktrees and Ticket Worktrees,
running a command in a worktree, telling whether a worktree is clean, and merging
and closing successful Ticket Worktrees.
_Avoid_: Worktree Repository

## Sources

**Ticket Source** (short form: **Source**):
The origin a Ticket is read from, with events reported to it: claimed, released,
escalated, retried, and done. It converts external records to uniform Tickets and
expresses each event in its own way; nothing saves a Ticket to it. Source identity
travels with the Ticket's identity and does not affect processing rules.
_Avoid_: Backend, provider, tracker, store, repository

**Ticket Stream**:
The ongoing sequence of uniform Tickets acquired from a Source for processing by the
Engine. Records are converted before entering the stream, so consumers use the same
Ticket model and processing rules regardless of origin.
_Avoid_: Raw issues, source records

**Issue**:
An external record in a tracker such as Linear that a Source converts into a Ticket.
_Avoid_: Ticket, task

## Eligibility

**Done**:
A Ticket whose work has landed: its Source sees it as done, or the Ledger records it
as done. Neither fact reverts. The Engine marks a Ticket done by reporting done to the
Source, which moves it without changing its content, and by recording done in the
Ledger once its work is merged.
_Avoid_: Completed, resolved, closed

**Unblocked**:
A Ticket whose blockers are all done. A blocker that cannot be found blocks.
_Avoid_: Ready, free

**Unclaimed**:
A Ticket with no Claim in the Ledger other than a Stale Claim, which its Source does
not see as claimed, as Linear sees an Issue in a started state. A Ticket its Source
sees as claimed is Unclaimed only when this host's Ledger holds a Stale Claim on it.
_Avoid_: Available, free, open

**Unattended**:
A Ticket whose HITL is no, allowing it to proceed without a human.
_Avoid_: AFK, automated, no-HITL

**Eligible**:
An Unblocked, Unclaimed, Unattended Ticket that is neither done nor escalated, which
the Engine may take next.
Eligibility is distinct from a stored ready-for-agent status.
_Avoid_: Ready, next, pollable
