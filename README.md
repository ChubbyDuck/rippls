# Rippls

![A duck creating concentric ripples on a calm pond](docs/assets/pond-ripple-hero.jpg)

Rippls is an opinionated ticket workflow engine for AI agents. It defines a ticket format, lifecycle
rules, and reusable **Strategies** of configured steps. A pool of named
**Runners** processes a **Ticket Stream**. By default the work happens in place, in the
Repository Root on your current branch; config moves it into isolated Git worktrees.

Rippls is a CLI. Install it with npm or pnpm, then run it from the Git repository
you want it to process. No clone of this project is required.

## Start here

- New user: [Before you start](#before-you-start) and
[Quick start with folder tickets](#quick-start-with-folder-tickets)
- Running tickets: [Which tickets are eligible?](#which-tickets-are-eligible) and
[Running the Engine](#running-the-engine)
- Connecting a Source: [Folder Source](#folder-source) or
[Linear Source](#linear-source)
- Tuning execution: [Configuration](#configuration) and
[Day-to-day recipes](#day-to-day-recipes)
- Understanding Git behavior: [Projects and worktrees](#projects-and-worktrees)



## How the parts fit together

| Term | Meaning |
| --- | --- |
| **Engine** | Coordinates the Runners processing Tickets. |
| **Runner** | A named worker reused across successive Tickets. |
| **Ticket Source** | Reads external records and converts them into Tickets, and receives reports of what happened to them: each Claim, release, escalation, retry, and done. Rippls never saves a Ticket to it. |
| **Ledger** | The Engine's own local record of Ticket Processing, where each Claim and Escalation lives. |
| **Ticket Stream** | The ongoing sequence of uniform Tickets supplied for processing. |
| **Ticket Processing** | The shared lifecycle: claim, apply a Strategy, run the check command, make sure the work is committed, then complete or escalate. |
| **Strategy** | A reusable procedure for performing a Ticket's work through a Harness: a named list of configured steps. |
| **Harness** | A coding integration such as Claude Code, Codex, Cursor, or OpenCode. |
| **Agent** | A running instance of a Harness's model on a Runner; each invocation creates a new Agent. |

Tickets have the same domain shape before entering the Ticket Stream. The Engine and
Runners apply the same processing rules regardless of whether a Ticket came from a
folder or Linear; the Source handles conversion and expresses each reported event in
its own way.

The **Strategy Selector** chooses the procedure for a Ticket, while the
**Harness Selector** chooses the coding integration. A Ticket Kind describes the work; a Strategy
describes how to perform it. Each Ticket Kind has one configured Strategy, named after
it, unless config gives it none. Ticket Processing owns claiming, the check, the commit,
completion, and escalation across Strategies.

The **Workspace** is where all Agents for one Ticket perform its work: **in place**, in
the Repository Root itself (the default), or in a **Ticket Worktree** (see
[Workspace](#workspace)). The **Worktree Manager** prepares the Workspace of a ticket,
runs a command in it, tells whether it is clean, and merges and closes successful Ticket
Worktrees. In place, it has one adapter that prepares the Repository Root on its current
branch and merges nothing.

## What a run does

1. Acquires the next eligible **Ticket** through the **Ticket Stream**, which polls the configured **Source**,
  claims it in the **Ledger**, and reports the **Claim** to the Source.
2. Hands it to a stable, named **Runner**, which the Claim then names.
3. Selects a configured **Harness**.
4. Prepares the **Workspace**. In place, it is the Repository Root on its current
  branch, with nothing created or installed. With Ticket Worktrees, it creates a
  `ticket-<source>-<id>` branch and **Ticket Worktree**.
5. With Ticket Worktrees, installs workspace dependencies with `corepack pnpm install`
  when needed.
6. Runs the selected **Strategy**, which invokes the **Harness** to create Agents for its steps.
7. On success, runs the configured check command in the Workspace, and sends a fix
  prompt to the Harness when it fails (see [Check command](#check-command)).
8. Once the check passes, or when none is configured, makes sure the work is committed:
  a Workspace with uncommitted work gets the commit prompt (see
  [Commit prompt](#commit-prompt)).
9. Once the Workspace is clean, reports done to the Source, merges the ticket
  branch (in place, there is nothing to merge), records done in the Ledger, completes
  the ticket on the Source, and then releases its Claim (see
  [Completion and `done/`](#completion-and-done)).
10. On Strategy failure, a check that still fails after its fix attempts, work that is
  still uncommitted after the commit prompt, or a done report the Source does not
  accept, retains the Ticket Worktree (in place, leaves the tree as it is), records an
  **Escalation** in the Ledger, reports the escalation to the Source, and then releases
  the Claim. The ticket keeps its kind and `hitl`. When the report fails, the Claim stays
  (see [Escalation](#escalation)).

The **Limit** caps Tickets taken from the stream, rather than successful completions.
A run is a **Drain** by default: it ends as soon as the Engine is **Idle**, with no Ticket
Processing in progress and no Eligible ticket, and then prints each ticket it held back
with its Ticket Status and reason. A **Watch** (`--watch`) keeps polling while Idle and
takes a ticket as soon as it becomes Eligible; it ends only after an idle timeout that is
set. A Strategy failure, a failed check, uncommitted work, or a failed done report
escalates the Ticket and halts the run.

## Before you start

You need:

- Node.js 24 or newer
- Git, with a commit name and email configured
- At least one supported Harness CLI installed and authenticated:
  - `agent` for Cursor
  - `codex` for Codex
  - `claude` for Claude Code
  - `opencode` for OpenCode

Only the Harness CLIs named in your configuration need to be installed. With no
config file, Rippls uses Codex, Cursor, Claude, and OpenCode.

Install the CLI:

```bash
npm install -g rippls
```

Or run it without a global install:

```bash
npx rippls --limit 1
```

pnpm and yarn work the same way (`pnpm add -g rippls`, `pnpm dlx rippls`).

Run commands from the Git repository you want Rippls to modify. Rippls discovers the
**Repository Root** with `git rev-parse --show-toplevel`.

## Quick start with folder tickets

Create a folder for tickets:

```bash
mkdir -p .agents/tickets
```

Rippls takes the nearest `.agents/tickets` at or above the folder where you start it, up
to the **Repository Root**, so starting inside one app of a monorepo runs that app's
queue. It prints the queue it uses when a run starts. With no queue there, it fails and
names `rippls init` and the `source.ticketsDir` key. A configured `ticketsDir` wins over
the lookup, and may be a path relative to the **Repository Root**. Rippls also defaults
to the four named Harnesses and needs no config file.

Add `.agents/tickets/1-first-ticket.md`:

```md
---
id: 1
title: Add a health endpoint
project: health-endpoint
status: ready-for-agent
kind: implementation
blockedBy: []
blocks: []
---

Add `GET /health`. Return JSON containing `{ "status": "ok" }` and cover it with
an automated test.
```

Process exactly one ticket:

```bash
npx rippls --limit 1
```

Because this example has a project, its ticket branch is merged into the persistent
`health-endpoint` project branch. Review that branch and merge it into your main branch
when ready. If Git tracks `.agents/tickets/`, the move of the ticket into
`.agents/tickets/done/` is a commit on that branch, and reaches your main branch with
the merge; until then the Ledger keeps the ticket done. If Git ignores the folder, the
ticket moves into `done/` as soon as the ticket branch is merged (see
[Completion and `done/`](#completion-and-done)).

## Which tickets are eligible?

A ticket is **Eligible** when all three conditions hold:

- **Unblocked**: every blocker of the ticket is done. A ticket with no blockers is
  Unblocked. A folder ticket names its blockers in a `blockedBy` field or a "Blocked by"
  line (see [What a ticket needs](#what-a-ticket-needs)).
- **Unclaimed**: the **Ledger** holds no Claim on it. A `claimedBy` field or a
  `claiming`/`claimed` status that an earlier Rippls wrote into a ticket is ignored.
- **Unattended**: its HITL is `no` (see [Ticket kinds and HITL](#ticket-kinds-and-hitl)).

A done ticket is never Eligible, and neither is an escalated ticket (see
[Escalation](#escalation)). A ticket is done when its Source sees it as done or the
Ledger records it as done (see [Completion and `done/`](#completion-and-done)).
A ticket stores no Ticket Status: a `status` value in a file is read only as a marker
of readiness. Rippls never writes it; polling applies the conditions above.

Folder tickets are ordered by folder, then by the numeric filename prefix, lowest first
(see [Feature folders](#feature-folders)). Linear tickets are ordered by creation time,
oldest first. `--project` narrows the poll to one project.

## Ticket kinds and HITL

Every ticket has one kind: the kind it states, or the default kind from config
(`implementation` unless `defaultKind` sets another). A kind that a ticket states
implies whether a human must be in the loop:

- `implementation` implies `hitl: no`.
- `research` implies `hitl: no`.
- `prototype` implies `hitl: yes`.
- `grilling` implies `hitl: yes`.
- `task` implies nothing.

A ticket is HITL `no` only when it says so. Its HITL is the first of these that the
ticket states:

1. A `hitl` field (or a `hitl:*` label on Linear).
2. A marker: `ready-for-agent` means `no`, and `ready-for-human` means `yes`. A folder
   ticket states it in a `status` field or in a "Status" line of its body, such as
   `**Status:** ready-for-agent`. Other `status` values, such as `open` or `blocked`,
   are no marker.
3. A kind that implies a HITL.

Otherwise the HITL is `yes`, so a draft is never taken by accident. A kind that comes
from the default implies nothing: a bare note is HITL `yes`. For a folder where every
file is ready, set `defaultHitl: 'no'` on the folder Source (see
[Folder Source](#folder-source)).

Each kind runs the Strategy configured for it (see [Strategies](#strategies)). By
default `implementation` runs an implement step and then a verdict step, and `research`
and an unattended `task` run one step. The Engine makes sure the work of every kind is
committed (see [Commit prompt](#commit-prompt)). `prototype` and `grilling` have no
default Strategy; they imply `hitl: yes`, so the Engine does not claim them unless a
ticket states `hitl: no`, and then the run stops with an error unless config gives the
kind a Strategy.

## Running the Engine

```text
rippls [flags]
```

To see where each ticket stands instead, run `rippls status` (see
[Ticket status](#ticket-status)).

Common flags:

- `--project <name>` processes only tickets in that project.
- `--limit <count>` caps how many Tickets this run takes from the Ticket Stream.
- `--concurrency <count>` keeps that many Runners available. Default: `1`. In place,
  a Concurrency above one fails at start: set `workspace: worktree` first (see
  [Workspace](#workspace)).
- `--watch` keeps the run polling while Idle, instead of ending it (a Watch rather than a
  Drain).
- `--idle-timeout <duration>` ends a Watch after continuous Idle time. Default: none, so a
  Watch runs until it is stopped. A Drain ignores it.
- `--poll-interval <duration>` controls empty-poll delay. Default: `10 seconds`.
- `--source folder|linear` selects a Source tag.
- `--log-level <level>` changes console logging.
- `--help` prints all flags.
- `--version` prints the CLI version.

Source-specific settings still come from the config (see [Configuration](#configuration)).
Selecting a different Source with `--source` does not supply its required `teamId`; a
folder Source without `ticketsDir` takes the nearest queue. With no config file, Rippls
uses a folder Source at the nearest `.agents/tickets`.

Examples:

```bash
# Safest first run: one ticket, one Runner
npx rippls --limit 1 --concurrency 1

# Process up to six tickets with two concurrent Runners (needs `workspace: worktree`)
npx rippls --limit 6 --concurrency 2

# Watch one project in the background, and stop after an hour Idle
npx rippls --project billing --watch --idle-timeout "1 hour"

# Poll a slower external Source
npx rippls --poll-interval "30 seconds"

# Inspect the generated CLI help
npx rippls --help
```

### Reported at Engine start

Before it takes a ticket, the Engine prints what it cannot read or resolve, then runs
as usual:

- one line for each ticket that is unreadable because of its front matter, an invalid
  hint, or a file that cannot be read from disk, with the reason;
- one line for each folder below the tickets folder that cannot be read, with the
  reason: none of its tickets is taken, and the tickets of every other folder are;
- one line for each blocker that cannot be resolved, with the ticket and the reference;
- one line with the count of Markdown files that have no numeric prefix.

```text
folder:7 (07-broken.md) is unreadable and is not taken: unparseable front matter: it has no closing `---`
web/ is unreadable, so none of its tickets is taken: folder cannot be read: PermissionDenied: FileSystem.readDirectory (/repo/.agents/tickets/web)
folder:3 has a blocker that cannot be resolved, so it stays blocked: folder:99
2 files have no numeric prefix, so they are not read as tickets
```

`--project` narrows the blockers it reports to the tickets of that Project. It reports
unreadable files whatever their Project, since an unreadable file's Project cannot be
read.

Use `Ctrl-C` to stop a run. On exit an Engine ends only the Claims it holds, and reports
to the Source the end state that the Ledger shows for each: done, escalated, or released.
The Claims of another Engine on the same
Repository Root stay in place, so two Engines can run side by side.

## Ticket status

```text
rippls status [--project <name>] [--source folder|linear]
```

`rippls status` prints one line for every ticket in scope: its identity, its title,
and its **Ticket Status**. It changes nothing. The Ticket Status is derived from
the ticket, the Ledger, and the done tickets; the ticket file does not hold it.

| Ticket Status | Meaning |
| --- | --- |
| `unreadable` | Its Source cannot read it (see [What a ticket needs](#what-a-ticket-needs)). |
| `done` | Its Source sees it as done, or the Ledger records it as done. |
| `escalated` | The Ledger holds an Escalation for it (see [Escalation](#escalation)). |
| `claimed` | The Ledger holds a Claim on it that is not stale. |
| `not ready` | Its `hitl` is `yes`. |
| `blocked` | One of its blockers is not done. |
| `eligible` | The Engine may take it next (see [Which tickets are eligible?](#which-tickets-are-eligible)). |

When several values apply to one ticket, the first in this table is shown. A ticket
whose only Claim is stale shows the value it would have without that Claim.

A claimed ticket also shows the holder of its Claim: the Engine, the Runner (or `no
Runner yet`), the process ID, and the host. A ticket whose only Claim is stale shows
the holder of that Claim the same way, marked `Stale Claim`, so you can tell a running
Claim from one whose process has ended. An escalated ticket shows the reason of its
Escalation, the attempt count, and the path of its retained Ticket Worktree, or `in
place` for a ticket of the in-place Workspace. For a
failed Strategy, the reason names the step that failed, by its position in the
Strategy, and how it failed: a Harness error, its time limit, or a verdict other than
pass. A blocked
ticket shows which of its blockers are open and which cannot be resolved; any other
ticket that is not done shows the blockers that cannot be resolved. After the
tickets, every unreadable file, folder, or Issue is listed with its reason, under its
identity when Rippls can tell one and `-` otherwise. A folder is named by its path with
a trailing `/`.

```text
folder:1  Add login                   claimed  (Claim: Engine honey-wren-c9w5, Runner honey-wren-c9w5:0, process 21474, host build-box)
folder:2  Add logout                  blocked  (Blockers: open folder:1; unresolved folder:9)
folder:3  Add the session store       done
folder:4  Add sign-up                 escalated  (Escalation: strategy failure: step 2, verdict other than pass, 1 attempt, Ticket Worktree /repo/.sandcastle/worktrees/ticket-folder-4)
folder:5  Choose the password policy  not ready  (HITL: yes)
folder:6  Add password reset          eligible  (Stale Claim: Engine moss-heron-k2p8, Runner moss-heron-k2p8:0, process 20117, host build-box)
-         README.md                   unreadable  (no numeric prefix)
folder:7  07-broken.md                unreadable  (unparseable front matter: it has no closing `---`)
```

`--project` and `--source` scope the list as they scope the Engine, before or after
`status`. `rippls` without a subcommand runs the Engine, as before.

## Claims and the Ledger

The Engine records each Claim in its **Ledger**, not in the ticket. The Ledger keeps one
record per ticket in `rippls/ledger/` inside the Git common directory of the Repository
Root (usually `.git/rippls/ledger/`). Every worktree shares it, it never appears in a
merge, and it needs no ignore rule. The Ledger is local for every Source, Linear
included.

A Claim is made by creating its record exclusively, so only one Engine can claim a
ticket. The record names the Engine, its process ID, and its host, and the Runner once
the ticket is handed to one. The Engine claims a ticket when it takes it from the
Ticket Stream, and removes the Claim when the ticket is done or escalated and the Source
has heard it, or when the Engine exits.

The Engine reports each Claim to the Source. When the Source cannot confirm it, the
report may still have changed the ticket there, so the Engine keeps the Claim, does not
process the ticket, and takes another one. It reports the end state when it exits.

### Stale Claims

A Claim is **stale** when its process no longer runs on this host, for example after an
Engine was killed. A Claim whose process still runs is never stale, and a Claim from
another host is never stale either: the Engine cannot see the processes of another host.

A ticket whose only Claim is stale is Unclaimed, so a Claim left on this host never needs
removing by hand. When the Engine looks for its next ticket and meets a Stale Claim, it replaces it:

1. It turns the stale record into its own Claim in the Ledger, in one step, so the
   ticket has a record at every moment. Of several Engines that meet the same Stale
   Claim, only one wins the replacement; the others take another ticket.
2. It reports released to the Source.
3. It reports claimed to the Source, as for any Claim.

- **Folder Source:** released and claimed change nothing, so the ticket is simply
  taken again.
- **Linear Source:** the Engine stopped while the issue was in a `started` state, which
  reads as claimed on Linear. Rippls takes a started issue only when this host's Ledger
  holds a Stale Claim on it. The released report returns the issue to an `unstarted`
  state and unassigns it; the claimed report assigns it and moves it to a `started` state
  again. If a person has taken the issue in the meantime, the released report leaves it
  as it is, the claimed report fails, and the person keeps the issue.

A Stale Claim on a ticket that the Ledger shows as escalated or done is not replaced to
take the ticket. The Engine that wins the replacement reports the end state (escalated,
or done, which completes the ticket on the Source as after the merge), removes the record
once the Source accepts the report, and does not take the ticket. When the report fails,
its Claim stays until the Engine exits, and the exit reports again.

If the released report fails, the Engine still holds its new Claim and goes on to the
claimed report. If that report fails, as it does on Linear for an issue that is still
started, the ticket is not processed, and the Engine reports the release again when it
exits.

On exit, an Engine removes the record of each of its Claims only after the Source accepts
the report of its end state: done, escalated, or released, as the Ledger shows. When the
report fails, the record stays, and it becomes a Stale Claim that a later run finishes.
A Claim from another host stays until someone removes its record from the Ledger folder.

## Completion and `done/`

A ticket is done exactly when its work has landed. Rippls never changes the content of
a ticket to mark it done. When the Strategy succeeds, the Engine:

1. reports done to the Source,
2. merges the ticket branch and closes the Ticket Worktree; in place, the work is already
   on the current branch, and this step does nothing,
3. records done in the Ledger,
4. completes the ticket on the Source, which for a folder ticket outside Git or a Linear
   issue is the step that cannot run before the merge,
5. releases the Claim.

The Claim stays until the Source has completed the ticket. When that step fails after the
merge, the work has landed and the Ledger records done, so the failure is logged, the
Claim stays until the Engine exits, and the exit completes the ticket again. A later
Engine that meets the record as a Stale Claim does the same. Only the Linear Source has
anything left to complete: a folder ticket moves into `done/` with the merge, and when
the move of a ticket file that Git does not track fails after the merge, it is logged,
not repeated on exit, and the Ledger alone keeps the ticket done.

A merge that fails halts the Engine, and the Ledger records no done. The log says why:
what Git wrote, such as the conflicting files, or that a merge is already in progress in
the directory the work merges into. A done report that fails escalates the ticket, as a
failed Strategy does.

Done is the union of two facts: the Source sees the ticket as done (its file is in
`done/`, or its Linear issue is completed), or the Ledger records it as done. Neither
fact reverts. Eligibility, blockers, and `rippls status` all use this union.

For the folder Source, done moves the ticket file into the `done/` of its folder, such
as `ticketsDir/done/` or `ticketsDir/auth/done/`, with its content unchanged. Where the
move happens depends on whether Git tracks the file:

- **In place.** The file is in the Repository Root. When Git tracks it, Rippls moves it
  into `done/` and commits the move on the current branch, with the message
  `chore: move ticket <identity> to done`. When Git does not track it, as in a tickets
  folder that Git ignores, Rippls moves the file on the filesystem only, with no commit.
  A Project changes nothing here.
- **Git tracks the ticket file, with Ticket Worktrees.** The file is in the Ticket
  Worktree. Rippls moves it
  into `done/` there and commits the move on the ticket branch before the merge, with
  the message `chore: move ticket <identity> to done`. Commit hooks run; a commit they
  reject escalates the ticket. The move lands with the work:
  - Without a project, the merge moves the file in the Repository Root.
  - With a project, the merge moves it on the project branch. The file in the
    Repository Root stays open until you merge the project branch. Meanwhile the
    Ledger keeps the ticket done: the Engine does not take it again, and its
    dependents are Unblocked.
- **Git ignores the tickets folder, or the ticket is not committed, with Ticket
  Worktrees.** Rippls moves the file in the tickets folder once the merge succeeds, with
  or without a project. After
  a failed merge the file stays where it is.

A ticket file that is already in `done/` is not moved again, for example when the Agent
moved its own ticket on the ticket branch. An Agent may tick checkboxes or edit its
ticket; the edit is ordinary work and merges with the rest.

For the Linear Source, done moves the issue to a `completed` state.

If the Ledger is lost, a done project ticket whose project branch is not yet merged
becomes Eligible again.

## Escalation

When a Strategy fails, the check command still fails after its fix attempts, the
Workspace still has uncommitted work after the commit prompt, or the Source does
not accept the done report, the Engine escalates the ticket and halts the run:

1. It records an **Escalation** in the Ledger with the reason, the attempt count, and
   the path of the retained Ticket Worktree. In place there is no Ticket Worktree to
   retain: the Escalation records no path, and the tree is left as it is. The reason
   is `check failure`,
   `commit failure`, `done report failure`, or, for a failed Strategy, the step that failed, by its position,
   and how its last run failed:
   - `strategy failure: step 2, Harness error`
   - `strategy failure: step 2, time limit reached`
   - `strategy failure: step 2, verdict other than pass`
2. It reports the escalation to the Source.
3. It releases the Claim once the Source has accepted the report. When the report fails,
   the Claim stays, and the exit that follows the halt reports the escalation again.

The ticket itself is not changed: it keeps its kind and `hitl`. An escalated ticket is
not Eligible, in this run or a later one, until it is retried. Each Escalation is a
record in `rippls/ledger/escalations/` inside the Git common directory (usually
`.git/rippls/ledger/escalations/`). Another escalation of the same ticket raises its
attempt count.

- **Folder Source:** nothing else happens. The ticket file stays byte-for-byte as it
  was.
- **Linear Source:** the issue is unassigned, moved to an `unstarted` state, and given
  the `needs-human` label. Its `kind` and `hitl` labels stay. See
  [Linear Source](#linear-source).

### Retry an escalated ticket

```text
rippls retry <ticket>
```

`rippls retry` returns an escalated ticket to unattended processing, without editing
any file. Give it the identity that `rippls status` shows, such as `folder:4`. The
retry goes to the Source that the identity names; a `--source` that names another
Source is an error. The retry:

1. Reports retried to the Source.
2. Clears the Escalation in the Ledger: its record moves to
   `.git/rippls/ledger/cleared/`. The attempt count is kept, so another escalation of
   the ticket raises it.

The next Engine run takes the ticket again and continues in its retained Ticket
Worktree, so the earlier work and any fixes you made there are kept. In place, the retry
leaves your tree as it is, and the next run continues in the Repository Root.

- **Folder Source:** nothing else happens.
- **Linear Source:** the `needs-human` label is removed from the issue.

A retry of a ticket that is not escalated prints an error and changes nothing. If the
Source cannot take the report, the Escalation stays in place, so you can run the
retry again.

## Configuration

Configuration is optional. Rippls reads two config files, each named
`rippls.config.ts` (or `.js`, `.json`, `.yaml`, `.yml`):

- the **user config**, in `$XDG_CONFIG_HOME/rippls/`, or `~/.config/rippls/` without
  it, for personal defaults that apply to every repository;
- the **repository config**, at the **Repository Root**.

The repository config wins. Plain objects merge key by key at every level; arrays and
values replace, so a repository that sets `harnesses` replaces the user's list, and a
Strategy given for a Kind replaces that Kind's Strategy whole. Neither file is required.
A relative `ticketsDir` in either file is resolved against the **Repository Root**.

With neither file, Rippls uses Codex, Cursor, Claude, and OpenCode, and a folder Source
at the nearest `.agents/tickets` (see [Quick start](#quick-start-with-folder-tickets)).

With neither file, the work happens in place, one ticket at a time (see
[Workspace](#workspace)).

To override those defaults, export `engineFileConfig` or a default object:

```ts
export const engineFileConfig = {
  harnesses: [{ name: 'Cursor' }],
  source: {
    _tag: 'folder',
    ticketsDir: '.agents/tickets',
  },
};
```

### Workspace

```ts
workspace: 'in-place', // the default; or 'worktree'
```

- **`in-place`.** The work of every ticket happens in the Repository Root and lands on
  your current branch, as you would work by hand. No worktree is created and no
  dependencies are installed. Your `.env`, ports, and end-to-end suite behave as they do
  for you. Nothing is merged. A Concurrency above one fails at start, since every
  Runner would share the Repository Root. The check for a clean Workspace after the Strategy ignores
  untracked files under the tickets folder, so a queue that Git does not track still
  works; ignored files never count.
- **`worktree`.** Each ticket gets its own Ticket Worktree and branch under
  `.sandcastle/worktrees/`, with its dependencies installed, and success merges it (see
  [Projects and worktrees](#projects-and-worktrees)). Use it for a Concurrency above one.

ADR-0005 records why in place is the default.

### Ticket fallbacks

A ticket that states no kind gets the default kind. It implies no HITL:

```ts
defaultKind: 'implementation', // the default
```

The folder Source also takes the HITL of a ticket that states no HITL, no marker, and
no kind that implies one (see [Folder Source](#folder-source)).

### Harness rotation

Without priorities, Harnesses rotate in the order listed:

```ts
export const engineFileConfig = {
  harnesses: [
    { name: 'Codex' },
    { name: 'Cursor' },
    { name: 'Claude' },
    { name: 'OpenCode' },
  ],
};
```

Priorities create a weighted rotation. Either every Harness must have a positive priority
or none may have one, and the highest priority must be unique:

```ts
harnesses: [
  { name: 'Cursor', priority: 3 },
  { name: 'Codex', priority: 1 },
],
```

Harness selection is independent of Runner identity. A Runner can process successive
tickets with different Harnesses.

### Scheduled Harness rotation

A schedule temporarily replaces the default rotation. The first active schedule entry
wins. The short form supports whole-hour windows and handles windows that cross
midnight:

```ts
schedule: [
  {
    harnesses: [{ name: 'Cursor' }],
    rule: {
      freq: 'DAILY',
      from: '18:00',
      to: '09:00',
      tzid: 'Europe/Helsinki',
    },
  },
],
```

For more precise schedules, provide an `rrule` object:

```ts
schedule: [
  {
    harnesses: [{ name: 'Codex' }, { name: 'Cursor' }],
    rrule: {
      freq: 'WEEKLY',
      byweekday: ['MO', 'TU', 'WE', 'TH', 'FR'],
      byhour: [9, 10, 11, 12, 13, 14, 15, 16],
      tzid: 'Europe/Helsinki',
    },
  },
],
```

See `src/config/examples/schedule.ts` for a complete short-form example.

### Check command

Rippls runs your repository's own check command to judge the work of a ticket. The
exit code is the verdict: zero passes. No skill has to print anything special.

```ts
check: {
  command: 'pnpm typecheck && pnpm lint && pnpm test',
  projects: {
    web: 'pnpm --filter web check',
  },
  timeLimit: '10 minutes', // the default
  fixAttempts: 1, // the default
  fixPrompt: 'Run /fix-check on the output below.', // unset, a prose prompt that names no skill
},
```

- **When.** The Engine runs the command in the Workspace after the Strategy
  succeeds and before the merge.
- **Command.** `command` runs for a ticket without a Project. A ticket of a Project that
  `projects` names runs that override; a ticket of any other Project runs `command`.
  The command runs through `sh -c`, so `&&`, pipes, and quoting work as in a terminal.
- **Time limit.** A command that runs longer than `timeLimit` is ended, with every
  process it started, and counts as a failed check.
- **Fix attempts.** On a non-zero exit code or the time limit, the Engine sends the fix
  prompt to the Harness, in the same Ticket Worktree, with the command, how it ended,
  and the last 200 lines of its output. Then it runs the command again. After
  `fixAttempts` fixes, a check that still fails escalates the ticket (see
  [Escalation](#escalation)) and nothing is merged. With `fixAttempts: 0` the first
  failure escalates.
- **Not configured.** With no command for the ticket, the check is skipped and the
  Engine logs that it was skipped. An empty string is no command.

The steps of the [Strategy](#strategies), verdict steps included, run first; the check
runs after them.

### Commit prompt

Rippls makes sure the work of a ticket is committed, whichever skill did it. After the
check command and its fix attempts, the Engine asks whether the Ticket Worktree is
clean: no uncommitted change, and no untracked file that Git does not ignore.

- **Clean.** A skill that already committed needs nothing more, and nothing runs.
- **Dirty.** The Engine sends the commit prompt to the Harness, in the same Ticket
  Worktree, then asks again.
- **Still dirty.** The ticket escalates with the reason `commit failure` (see
  [Escalation](#escalation)) and nothing is merged. No fix attempt follows, so a
  failing pre-commit hook is never hidden.

```ts
commit: {
  prompt: '/commit ticket {{id}}: {{title}}', // unset, a prose prompt that names no skill
  model: { fast: true, tier: 'low' }, // the default
},
```

- **Prompt.** A template that can refer to the ticket with `{{id}}` (its identity),
  `{{title}}`, `{{body}}`, and `{{project}}`. `{{project}}` is empty for a ticket
  without a Project. Any other `{{…}}` stays as written. Unset, the prompt asks in
  plain prose to commit all work in the worktree with a conventional commit message
  that names the ticket.
- **Model.** The model demand of the commit run, with `tier` (`low`, `mid`, or
  `high`), `fast`, and `generation` (`current` or `previous`). A demand that is set
  replaces the default one whole. When the Harness has no matching model, it uses its
  default model.

### Strategies

A Strategy is a named list of steps. The Strategy Selector picks the Strategy of a
ticket by its kind, and the Engine sends each step's prompt to the Harness in turn, in
the same Ticket Worktree. Each step is a separate Harness invocation, so each creates a
new **Agent**; the **Runner** stays the same throughout Ticket Processing.

Out of the box Rippls names no skill, so it works in a repository with nothing
installed. The default Strategies are plain prose:

- `implementation`: an implement step, then a verdict step that judges the work against
  the ticket's acceptance criteria, with a ten-minute limit and one retry.
- `research`: one step that does the research the ticket asks for.
- `task`: one step that carries out the task.

A Strategy you configure for a kind replaces the default for that kind whole; the other
defaults stay. A name under `strategies` that is not a Ticket Kind, such as
`implementaton`, is a config error that names it and the valid kinds, so a typo never
leaves the default Strategy in place. A kind with no Strategy, such as `prototype` unless
you configure one, stops the run with an error when a ticket of it is taken.

This example drives `implementation` with skills:

```ts
strategies: {
  implementation: [
    {
      prompt: 'Use the implement skill on ticket {{id}}: {{title}}\n\n{{body}}',
      prompts: { Claude: '/implement {{body}}' },
      model: { tier: 'high' },
    },
    {
      prompt: 'Use the acceptance-gate skill on this ticket:\n\n{{body}}',
      prompts: { Claude: '/acceptance-gate {{body}}' },
      timeLimit: '10 minutes',
      retries: 1,
      verdict: true,
    },
  ],
},
```

- **Prompt.** A template over the ticket, as the [commit prompt](#commit-prompt) is:
  `{{id}}`, `{{title}}`, `{{body}}`, and `{{project}}`. Include `{{body}}`: the Engine
  tells the Agent that the ticket text is in the prompt.
- **Prompt per Harness.** `prompts` gives a prompt for one Harness by its name (`Codex`,
  `Cursor`, `Claude`, or `OpenCode`). When the selected Harness has one, it is sent in
  place of `prompt`. Any other name, such as `Claud`, is a config error that names it
  and the valid names, so a typo never falls back to `prompt`. A slash command is the
  syntax of one Harness, and how the others resolve one in a headless run varies, so keep
  `prompt` in plain prose that every Harness in the rotation can follow, and put a slash
  command in `prompts`.
- **Model.** The model demand of the step, as for the commit prompt. Unset, the Harness
  uses its default model. When the Harness has no matching model, Rippls logs the
  fallback and uses its default model.
- **Time limit.** A step that runs longer than `timeLimit` is ended and counts as
  failed. Unset, a step has no limit.
- **Retries.** A failed step runs again, as a new Agent, up to `retries` times (default
  `0`). A step that still fails fails the Strategy, which escalates the ticket (see
  [Escalation](#escalation)).
- **Verdict.** With `verdict: true`, the Engine appends an instruction to print a pass
  or a fail signal at the end, and reads the signal back. Anything but the pass signal,
  no signal included, fails the step. Your prompt only has to say what to judge.

After each step's prompt the Engine appends the facts it arranged: the Agent is in the
ticket's Workspace, and the ticket text is in the prompt. No Strategy sends a commit command: after the check command, the Engine sends
the [commit prompt](#commit-prompt) when the work is not committed yet.

### Runtime defaults and tracing

Defaults can be changed in the file and overridden by CLI flags:

```ts
idleTimeout: '1 hour', // a Watch only; no default
pollInterval: '10 seconds',
otlpTraceUrl: 'http://127.0.0.1:4318/v1/traces',
```

Omit `otlpTraceUrl` when no OTLP HTTP trace collector is running. Full Harness logs are
written under `.sandcastle/logs/`, separately from the concise Engine output.

### Environment of the Agent

An Agent runs with its Workspace as its working directory: the Repository Root in
place, or its Ticket Worktree. `.sandcastle/.env` is normally ignored by Git, so a
Ticket Worktree has none. Rippls reads the
`.sandcastle/.env` of the **Repository Root** and passes its keys to every Agent, as
Sandcastle reads the file for a run in the Repository Root: a key with a value there
wins over the same key in the shell, and a key with an empty value is left to the
shell. A missing file is not an error.

## Folder Source

Configure it with:

```ts
source: {
  _tag: 'folder',
  // Optional; without it, the nearest .agents/tickets at or above the start folder.
  ticketsDir: '.agents/tickets',
  // Optional; the HITL of a ticket that states none. Default: 'yes'.
  defaultHitl: 'no',
},
```


### File naming

Ticket files match `<numeric-id>*.md`, for example:

```text
1.md
2-add-login.md
003_document-api.md
```

The numeric filename prefix is authoritative: Rippls reads the ID from the filename.
Rippls never writes front matter, so keys it does not know stay as they are.

### Feature folders

Rippls reads `ticketsDir` recursively, so tickets can live directly in it or in one
folder per feature, with numbers that restart in each folder, as standard
ticket-writing skills lay them out:

```text
.agents/tickets/
  01-rename-the-api.md        folder:1
  done/02-old-work.md         folder:2, done
  auth/
    01-login.md               folder:auth/1, Project auth
    02-logout.md              folder:auth/2, Project auth
    done/03-signup.md         folder:auth/3, Project auth, done
  billing/plans/
    01-pricing.md             folder:billing/plans/1, Project billing
```

- **Identity.** The identity is the ticket's folder below `ticketsDir` plus the numeric
  value of its filename prefix, such as `folder:auth/1`. A `done` folder is not part of
  it. A ticket directly in `ticketsDir` has the identity `folder:<number>`. Use the
  identity with `rippls retry`.
- **Branch.** The Ticket Worktree and its branch are named from the identity, with
  every character other than a letter, a digit, `_`, or `-` replaced by `-`:
  `folder:auth/1` works on `ticket-folder-auth-1`.
- **Project.** A ticket with no `project` field belongs to the Project of the first
  folder below `ticketsDir`: `auth/01-login.md` and `billing/plans/01-pricing.md` are in
  Projects `auth` and `billing`. A stated `project` wins. A ticket directly in
  `ticketsDir` has no Project unless it states one. `--project auth` narrows a run to
  that Project, so its work accumulates in one Project Worktree (see
  [Projects and worktrees](#projects-and-worktrees)).
- **Done.** Each folder has its own `done/`: a ticket moves into the `done/` next to it.
- **Blockers.** A blocker number, in a `blockedBy` field or a "Blocked by" line, refers
  to a ticket in the same folder.
- **Order.** Tickets are taken by folder path, then by number, lowest first. Tickets
  directly in `ticketsDir` come first.

### What a ticket needs

A folder ticket needs only an identity and text. The identity is the ticket's folder
and the numeric filename prefix (see [Feature folders](#feature-folders)); the text is
the file. Everything else is a hint with a fallback:

| Hint | Read from | When missing |
| --- | --- | --- |
| Title | The `title` field, then the first heading without a leading ticket number and separator (`# 02: Add login` gives `Add login`), then the filename without its numeric prefix and extension (`2-add-login.md` gives `add-login`) | Always present |
| Kind | The `kind` field | `defaultKind` from config, `implementation` by default |
| HITL | The `hitl` field, then a marker, then a stated kind (see [Ticket kinds and HITL](#ticket-kinds-and-hitl)) | `defaultHitl` of the folder Source, `yes` by default |
| Blockers | The `blockedBy` field, with numeric folder ticket IDs, then a "Blocked by" line of the body (see [Blockers in a "Blocked by" line](#blockers-in-a-blocked-by-line)) | None |
| Project | The `project` field, then the first folder below `ticketsDir` (see [Feature folders](#feature-folders)) | None |

Front matter is optional, and so is a heading. The body is passed to the Strategy
unchanged: the text after the front matter, or the whole file when it has none. A key
with no value states nothing. A `blocks` list, a `claimedBy` field with or without a
value, and keys that Rippls does not know are ignored, and Rippls never removes them.

Rippls reads tickets in any of these shapes. Existing front matter tickets need no
change.

A ticket in the template of a standard ticket-writing skill, with no front matter:

```md
# 02: Document the health endpoint

**What to build:** a section in the guide for `GET /health`.

**Blocked by:** 01 (Add a health endpoint)

**Status:** ready-for-agent

- [ ] The guide shows the endpoint.
```

Its kind is the default, its marker makes it Unattended, and ticket 1 blocks it.

A bare note is a ticket too. Its Title is the filename, and it is HITL `yes` until it
says it is ready, or `defaultHitl` is `no`:

```md
Rename `createClient` to `makeClient` everywhere.
```

An unattended task:

```md
---
id: 12
title: Rename the public API
status: ready-for-agent
kind: task
hitl: no
blockedBy: []
blocks: [13]
---

Rename `createClient` to `makeClient` and update all call sites.
```

A dependent implementation:

```md
---
id: 13
title: Document the renamed API
status: blocked
kind: implementation
blockedBy: [12]
blocks: []
---

Update the public API guide to use `makeClient`.
```

When ticket 12 is done, its file moves to the `done/` of its folder and ticket 13 becomes
Unblocked. Rippls does not edit ticket 13: it reads the tickets in `done/` as done and
derives Unblocked on every poll. The stored `status: blocked` does not gate ticket 13.
A blocker that Rippls finds neither in the tickets folder nor in `done/` keeps its ticket
blocked.

#### Blockers in a "Blocked by" line

A ticket with no `blockedBy` field can name its blockers in a "Blocked by" line of its
body, as the template of a standard ticket-writing skill does. Rippls reads the first
such line outside a code block; the label may be bold, as in `**Blocked by:**`, and its
case does not matter.

```md
**Blocked by:** 02 (Unblocked is derived from done), 10 (A ticket needs only an identity and text).
```

- The line holds items separated by commas. An item starts with a ticket number; the
  text after the number, such as a title in parentheses, is ignored. A comma or a
  number inside parentheses belongs to its item, so `2 (after 5, 6)` names ticket 2
  only.
- A number refers to a ticket in the same folder. Leading zeros do not matter: `02` is
  ticket 2.
- `None`, with or without a remark, as in `None (can start immediately)`, means no
  blockers.
- An item that does not start with a number, such as a bare title, cannot be resolved
  and keeps the ticket blocked. So does a number that matches no ticket, open or in
  `done/`, and so does a line that names nothing, such as one whose items follow on
  the next lines: write them on the line itself.
- When a ticket has both a `blockedBy` field and a "Blocked by" line, the field wins.
  A `blockedBy` key with no value states nothing, so the line is read.

Done ticket files move to the `done/` of their folder unchanged (see
[Completion and `done/`](#completion-and-done)).

A Markdown file is unreadable when its name has no numeric prefix, its front matter
cannot be parsed, a hint it states has an invalid value, such as an unknown `kind`, or
the file cannot be read from disk (`file cannot be read`). A folder below the tickets
folder that cannot be read is unreadable too (`folder cannot be read`); the tickets of
every other folder are still read. A missing `done/` folder is no error.
Rippls does not take an unreadable ticket, and it reports every one: at Engine start
and in `rippls status`, with the reason (see [Reported at Engine start](#reported-at-engine-start)).
A blocker that cannot be resolved is reported the same way.

## Linear Source

Set an API key in the environment:

```bash
export LINEAR_API_KEY="lin_api_..."
```

Then configure the team:

```ts
export const engineFileConfig = {
  harnesses: [{ name: 'Cursor' }],
  source: {
    _tag: 'linear',
    teamId: 'your-team-id',
    // Optional; defaults to LINEAR_API_KEY.
    apiKeyEnv: 'LINEAR_API_KEY',
  },
};
```

See `src/config/examples/linear.ts` for the complete example.

### Required Linear setup

A Linear issue states its kind with one `kind:*` label:

```text
kind:implementation
kind:research
kind:prototype
kind:grilling
kind:task
```

An issue without a `kind:*` label has the default kind. It may state its HITL with
one of:

```text
hitl:no
hitl:yes
```

Linear has no marker, and a workflow state does not make an issue Unattended. An issue
is HITL `no` only through a `hitl:no` label or a `kind:*` label whose kind implies it
(see [Ticket kinds and HITL](#ticket-kinds-and-hitl)); otherwise it is HITL `yes`.
An issue with an unknown kind or HITL, or with more than one `kind:*` or `hitl:*`
label, is unreadable: Rippls does not take it, and reports it by its identifier, such as
`ENG-12`, at Engine start and in `rippls status`. It reports such an issue in an
`unstarted` state, and in a `started` state when the issue is assigned to the API-key
user, because Rippls claimed it. An unreadable issue in a `started` state that is
assigned to anyone else, or to no one, is a person's work in progress, and is not
reported.

Create a `needs-human` label in the team as well. Rippls adds it to an escalated issue,
and reads an issue that has it as `hitl: yes`, whatever its `kind`. Without the label,
an escalation still works: it is recorded in the Ledger, and Rippls logs a warning.
Issue data maps into tickets as follows:

- The Linear issue ID becomes the Source-scoped ticket ID.
- The title and description become the ticket title and body.
- The Linear project name becomes a lowercase, hyphenated project.
- Linear `blocks` relations become `blockedBy`.
- An issue in a `completed` state is done.

The Linear Source offers issues in an `unstarted` state for processing. An issue in a
`started` state is already claimed on Linear, so Rippls does not take it, unless this
host's Ledger holds a Stale Claim on it (see [Stale Claims](#stale-claims)).

When the Engine claims an issue, the Linear Source assigns it to the API-key user, moves
it to a `started` state, and reads it back to confirm. If someone else took the issue in
between, or the read fails, the Engine takes another ticket, keeps its Claim until it
exits, and then reports the release. A release changes only an issue that is still in a
`started` state and assigned to the API-key user: it returns the issue to an `unstarted`
state and unassigns it. An issue that a person has taken keeps its assignee and state.
Done moves an issue to a `completed` state, after the merge of its ticket branch succeeds.

If a Strategy fails, Rippls records the Escalation in its Ledger, unassigns the issue,
returns it to an `unstarted` state, and adds the `needs-human` label. It does not change
the `kind` or `hitl` labels. While the issue has `needs-human`, Rippls does not take it.
`rippls retry` removes the label (see [Retry an escalated ticket](#retry-an-escalated-ticket)).

## Projects and worktrees

In place, a Project gives no Project Worktree: all work lands on the current branch. A
Project still scopes `--project` and picks its check command override. The rest of this
section is about `workspace: worktree`.

With Ticket Worktrees, Project determines where successful ticket work accumulates:

- With no project, a Ticket Worktree branches from the Repository Root's current
`HEAD`, and success merges back into the Repository Root.
- With a project, Rippls creates or reuses a persistent **Project Worktree** and branch,
then creates Ticket Worktrees from that branch. Successful ticket branches merge
into the project branch.

Worktrees live under `.sandcastle/worktrees/`. Rippls adds no ignore rule for them, so add
`.sandcastle/` to your `.gitignore`: the worktrees and `.sandcastle/.env` then do not
show as untracked files. The Harness logs folder, `.sandcastle/logs/`, ignores itself in
either Workspace. Project Worktrees remain for later tickets and are not
merged into the Repository Root automatically. Ticket Worktrees are closed after success and retained after an escalation. A retried
ticket continues in its retained Ticket Worktree, with its commits and uncommitted
changes.

Before a run, keep the branch receiving merges in a reviewable state. Merge or otherwise
integrate a completed project branch yourself.

## Generate folder tickets

The generator creates fixture tickets in the configured folder Source:

```bash
pnpm generate [flags]
```

Options:

- `--count <number>` creates that many files. Default: `12`.
- `--kind <kind>` restricts kinds.
- `--status <status>` restricts the stored `status` of each file. A Source reads
  `ready-for-agent` only as a marker, and a `done` file is written into `done/`.
- `--hitl no|yes` restricts HITL.
- `--project <name>` assigns projects. Default: `generated`.
- `--chain` makes each ticket depend on the previous one.

Restriction flags can be repeated. When omitted, the generator cycles through all valid
values.

```bash
# Three unattended implementation tickets
pnpm generate --count 3 --kind implementation --hitl no

# A five-ticket dependency chain
pnpm generate --count 5 --kind implementation --status ready-for-agent --chain

# Cycle across selected projects
pnpm generate --count 4 --project api --project web
```

The generator uses IDs starting at `1`. Use it only in a disposable ticket directory:
matching existing files can be updated.

Remove generated-looking root ticket files:

```bash
pnpm clean-tickets
```

This deletes every `<numeric-id>*.md` file directly inside the configured ticket
directory. It does not remove `done/`. The command is destructive and does not
distinguish generated fixtures from hand-written tickets.

## Day-to-day recipes

Process a bounded batch before leaving it unattended:

```bash
npx rippls --project api --limit 4
```

Use a smaller Harness rotation:

```ts
harnesses: [{ name: 'Codex' }, { name: 'OpenCode' }],
```

Keep one preferred Harness in front of a fallback:

```ts
harnesses: [
  { name: 'Cursor', priority: 4 },
  { name: 'Codex', priority: 1 },
],
```

Generate shell completions:

```bash
npx rippls --completions zsh
npx rippls --completions bash
npx rippls --completions fish
```

Investigate a Harness failure:

1. Read the Engine error and `.sandcastle/logs/ticket-<identity>-*.log`, such as
   `ticket-folder:4-step-1.log`.
2. Inspect the retained Ticket Worktree under `.sandcastle/worktrees/`, or, in place,
   your own tree.
3. Run `npx rippls status` to see the reason of the Escalation and the retained
   worktree, or read its record in `.git/rippls/ledger/escalations/`.
4. Address the problem. You may fix it by hand in the retained worktree; the retry
   continues there and keeps your changes.
5. Return it to unattended processing with `npx rippls retry <ticket>`, for example
   `npx rippls retry folder:4`.



## Development commands

From a clone of this repository:

```bash
corepack enable
pnpm install
pnpm start
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm test:watch
pnpm generate
pnpm clean-tickets
```

The canonical domain vocabulary and lifecycle details are in [CONTEXT.md](CONTEXT.md).

## License

MIT. See [LICENSE](LICENSE).
