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
a new Agent, including retries.
_Avoid_: Harness, Model, Runner

**Model**:
The language model used by a Harness for an Agent's execution.
_Avoid_: Agent, Harness

## Tickets

**Ticket**:
A uniform unit of work with a source-scoped identity, Title, Ticket Kind, Ticket Status,
body, blocking relations, and an optional Project.
_Avoid_: Issue, task (the noun), job

**Ticket Kind**:
The class of work a Ticket represents: implementation, research, prototype, grilling,
or task. A Kind describes the work; a Strategy describes how to perform it.
_Avoid_: Type, category, Strategy

**HITL**:
Whether a human must be in the loop for a Ticket: yes or no.
_Avoid_: Human review, interactive, AFK

**Ticket Status**:
A Ticket's position in its lifecycle: open, ready-for-agent, claiming, claimed, done,
resolved, or blocked. Done records completed work; resolved is a separate status.
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
then record completion or escalate to a human. It owns claiming, completion, and
escalation across Strategies.
_Avoid_: Runner, run, execution, loop

**Claim**:
The exclusive assignment of a Ticket to a Runner.
_Avoid_: Lock, take, checkout

**Strategy**:
A named, reusable procedure for carrying out a Ticket's work through a Harness and
returning an outcome. Different Strategies may serve the same Ticket Kind.
_Avoid_: Handler, workflow, prompt

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
It is merged and closed after success and retained after escalation to a human.
_Avoid_: Project Worktree, per-prompt worktree

**Worktree Manager**:
The service responsible for preparing Project Worktrees and Ticket Worktrees, and
merging and closing successful Ticket Worktrees.
_Avoid_: Worktree Repository

## Sources

**Ticket Source** (short form: **Source**):
The origin a Ticket is read from and written to, responsible for converting external
records to uniform Tickets and Ticket changes back to those records. Source identity
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

**Unblocked**:
A Ticket with no remaining blockers.
_Avoid_: Ready, free

**Unclaimed**:
A Ticket not assigned to a Runner and not currently being claimed.
_Avoid_: Available, free, open

**Unattended**:
A Ticket whose HITL is no, allowing it to proceed without a human.
_Avoid_: AFK, automated, no-HITL

**Eligible**:
An Unblocked, Unclaimed, Unattended Ticket that the Engine may take next.
Eligibility is distinct from the ready-for-agent Ticket Status.
_Avoid_: Ready, next, pollable
