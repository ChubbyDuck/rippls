# Rippls

![A duck creating concentric ripples on a calm pond](docs/assets/pond-ripple-hero.jpg)

Rippls is an opinionated ticket workflow engine for AI agents. It defines a ticket format, lifecycle
rules, and reusable **Strategies** built around specific skills. A pool of named
**Runners** processes a **Ticket Stream**, with work performed in isolated Git worktrees.

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
| **Ticket Source** | Reads external records, converts them into Tickets, saves Ticket changes, and receives reports of each Claim, release, escalation, and retry. |
| **Ledger** | The Engine's own local record of Ticket Processing, where each Claim and Escalation lives. |
| **Ticket Stream** | The ongoing sequence of uniform Tickets supplied for processing. |
| **Ticket Processing** | The shared lifecycle: claim, apply a Strategy, then complete or escalate. |
| **Strategy** | A reusable procedure for performing a Ticket's work through a Harness. |
| **Harness** | A coding integration such as Claude Code, Codex, Cursor, or OpenCode. |
| **Agent** | A running instance of a Harness's model on a Runner; each invocation creates a new Agent. |

Tickets have the same domain shape before entering the Ticket Stream. The Engine and
Runners apply the same processing rules regardless of whether a Ticket came from a
folder or Linear; the Source handles conversion and persistence.

The **Strategy Selector** chooses the procedure for a Ticket, while the
**Harness Selector** chooses the coding integration. A Ticket Kind describes the work; a Strategy
describes how to perform it. Different Strategies can serve the same Kind, although the
current selector maps each Kind to one Strategy. Ticket Processing owns claiming,
completion, and escalation across Strategies.

The **Worktree Manager** prepares Project and Ticket Worktrees and merges and closes
successful Ticket Worktrees.

## What a run does

1. Acquires the next eligible **Ticket** through the **Ticket Stream**, which polls the configured **Source**,
  claims it in the **Ledger**, and reports the **Claim** to the Source.
2. Hands it to a stable, named **Runner**, which the Claim then names.
3. Selects a configured **Harness**.
4. Creates a `ticket-<source>-<id>` branch and **Ticket Worktree**.
5. Installs workspace dependencies with `corepack pnpm install` when needed.
6. Runs the selected **Strategy**, which invokes the **Harness** to create Agents for its steps.
7. On success, reports done to the Source, merges the ticket branch, records done in the
  Ledger, and releases its Claim (see [Completion and `done/`](#completion-and-done)).
8. On Strategy failure, retains the worktree, records an **Escalation** in the Ledger,
  releases the Claim, and reports the escalation to the Source. The ticket keeps its
  kind and `hitl`.

The **Limit** caps Tickets taken from the stream, rather than successful completions.
The Engine finishes processing the Tickets it has taken, or stops after the configured
idle timeout. A Strategy failure escalates the Ticket and halts the run.

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

Rippls defaults to that folder, the four named Harnesses, and no extra config file.
`ticketsDir` may be a path relative to the **Repository Root**.

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

Folder tickets are ordered by the numeric filename prefix, lowest first. Linear tickets
are ordered by creation time, oldest first. `--project` narrows the poll to one project.

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

Only `implementation` currently has the full implement, acceptance-gate, and commit
workflow. `research` and an unattended `task` invoke the Harness once and then complete;
they do not run that three-stage workflow. `prototype` and `grilling` imply
`hitl: yes`, so the Engine does not claim them.

## Running the Engine

```text
rippls [flags]
```

To see where each ticket stands instead, run `rippls status` (see
[Ticket status](#ticket-status)).

Common flags:

- `--project <name>` processes only tickets in that project.
- `--limit <count>` caps how many Tickets this run takes from the Ticket Stream.
- `--concurrency <count>` keeps that many Runners available. Default: `1`.
- `--idle-timeout <duration>` stops after continuous idle time. Default: `5 minutes`.
- `--poll-interval <duration>` controls empty-poll delay. Default: `10 seconds`.
- `--source folder|linear` selects a Source tag.
- `--log-level <level>` changes console logging.
- `--help` prints all flags.
- `--version` prints the CLI version.

Source-specific settings still come from `rippls.config.ts` (or `.js`, `.json`,
`.yaml`) at the **Repository Root**. Selecting a different Source with `--source`
does not supply its required `ticketsDir` or `teamId`. With no config file, Rippls
uses a folder Source at `.agents/tickets`.

Examples:

```bash
# Safest first run: one ticket, one Runner
npx rippls --limit 1 --concurrency 1

# Process up to six tickets with two concurrent Runners
npx rippls --limit 6 --concurrency 2

# Work only on one project and stop sooner when idle
npx rippls --project billing --idle-timeout "1 minute"

# Poll a slower external Source
npx rippls --poll-interval "30 seconds"

# Inspect the generated CLI help
npx rippls --help
```

Use `Ctrl-C` to stop a run. On exit an Engine releases only the Claims it holds and
reports each release to the Source. The Claims of another Engine on the same
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
| `done` | Its Source sees it as done, or the Ledger records it as done. |
| `escalated` | The Ledger holds an Escalation for it (see [Escalation](#escalation)). |
| `claimed` | The Ledger holds a Claim on it that is not stale. |
| `not ready` | Its `hitl` is `yes`. |
| `blocked` | One of its blockers is not done. |
| `eligible` | The Engine may take it next (see [Which tickets are eligible?](#which-tickets-are-eligible)). |

When several values apply to one ticket, the first in this table is shown. A ticket
whose only Claim is stale shows the value it would have without that Claim.

A claimed ticket also shows the owner of its Claim: the Engine, the Runner (or `no
Runner yet`), the process ID, and the host. An escalated ticket shows the reason of its
Escalation, the attempt count, and the path of its retained Ticket Worktree.

```text
folder:1  Add login                   claimed  (Claim: Engine honey-wren-c9w5, Runner honey-wren-c9w5:0, process 21474, host build-box)
folder:2  Add logout                  blocked
folder:3  Add the session store       done
folder:4  Add sign-up                 escalated  (Escalation: strategy failure, 1 attempt, Ticket Worktree /repo/.sandcastle/worktrees/ticket-folder-4)
folder:5  Choose the password policy  not ready
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
Ticket Stream, and releases the Claim when the ticket is done or when the Engine exits.

A Claim left by an Engine that stopped without releasing it keeps its ticket
unclaimable. Remove that ticket's record from the Ledger folder to free it.

## Completion and `done/`

A ticket is done exactly when its work has landed. Rippls never changes the content of
a ticket to mark it done. When the Strategy succeeds, the Engine:

1. reports done to the Source,
2. merges the ticket branch and closes the Ticket Worktree,
3. records done in the Ledger,
4. releases the Claim.

A merge that fails halts the Engine, and the Ledger records no done. A done report that
fails escalates the ticket, as a failed Strategy does.

Done is the union of two facts: the Source sees the ticket as done (its file is in
`done/`, or its Linear issue is completed), or the Ledger records it as done. Neither
fact reverts. Eligibility, blockers, and `rippls status` all use this union.

For the folder Source, done moves the ticket file into the `done/` of its folder, such
as `ticketsDir/done/` or `ticketsDir/auth/done/`, with its content unchanged. Where the
move happens depends on whether Git tracks the file:

- **Git tracks the ticket file.** The file is in the Ticket Worktree. Rippls moves it
  into `done/` there and commits the move on the ticket branch before the merge, with
  the message `chore: move ticket <identity> to done`. Commit hooks run; a commit they
  reject escalates the ticket. The move lands with the work:
  - Without a project, the merge moves the file in the Repository Root.
  - With a project, the merge moves it on the project branch. The file in the
    Repository Root stays open until you merge the project branch. Meanwhile the
    Ledger keeps the ticket done: the Engine does not take it again, and its
    dependents are Unblocked.
- **Git ignores the tickets folder, or the ticket is not committed.** Rippls moves the
  file in the tickets folder once the merge succeeds, with or without a project. After
  a failed merge the file stays where it is.

A ticket file that is already in `done/` is not moved again, for example when the Agent
moved its own ticket on the ticket branch. An Agent may tick checkboxes or edit its
ticket; the edit is ordinary work and merges with the rest.

For the Linear Source, done moves the issue to a `completed` state.

If the Ledger is lost, a done project ticket whose project branch is not yet merged
becomes Eligible again.

## Escalation

When a Strategy fails, the Engine escalates the ticket and halts the run:

1. It records an **Escalation** in the Ledger with the reason, the attempt count, and
   the path of the retained Ticket Worktree.
2. It releases the Claim.
3. It reports the escalation to the Source.

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
Worktree, so the earlier work and any fixes you made there are kept.

- **Folder Source:** nothing else happens.
- **Linear Source:** the `needs-human` label is removed from the issue.

A retry of a ticket that is not escalated prints an error and changes nothing. If the
Source cannot take the report, the Escalation stays in place, so you can run the
retry again.

## Configuration

Configuration is optional. When `rippls.config.ts` (or `.js`, `.json`, `.yaml`,
`.yml`) is absent from the **Repository Root**, Rippls uses Codex, Cursor, Claude,
and OpenCode, and a folder Source at `.agents/tickets`.

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

### Runtime defaults and tracing

Defaults can be changed in the file and overridden by CLI flags:

```ts
idleTimeout: '5 minutes',
pollInterval: '10 seconds',
otlpTraceUrl: 'http://127.0.0.1:4318/v1/traces',
```

Omit `otlpTraceUrl` when no OTLP HTTP trace collector is running. Full Harness logs are
written under `.sandcastle/logs/`, separately from the concise Engine output.

## Folder Source

Configure it with:

```ts
source: {
  _tag: 'folder',
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

When ticket 12 completes, its file moves to the `done/` of its folder and ticket 13 becomes
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

Completed files move to the `done/` of their folder unchanged (see
[Completion and `done/`](#completion-and-done)).

A file is unreadable when its name has no numeric prefix, its front matter cannot be
parsed, or a hint it states has an invalid value, such as an unknown `kind`. Rippls
does not take an unreadable ticket.

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
label, is unreadable, and Rippls does not take it.

Create a `needs-human` label in the team as well. Rippls adds it to an escalated issue,
and reads an issue that has it as `hitl: yes`, whatever its `kind`. Without the label,
an escalation still works: it is recorded in the Ledger, and Rippls logs a warning.
Issue data maps into tickets as follows:

- The Linear issue ID becomes the Source-scoped ticket ID.
- The title and description become the ticket title and body.
- The Linear project name becomes a lowercase, hyphenated project.
- Linear `blocks` relations become `blockedBy`.
- An issue in a `completed` state is done.

The Linear Source offers only issues in an `unstarted` state for processing. An issue in
a `started` state is already claimed on Linear, so Rippls does not take it.

When the Engine claims an issue, the Linear Source assigns it to the API-key user, moves
it to a `started` state, and reads it back to confirm. If someone else took the issue in
between, the Engine releases its Claim and takes another ticket. A release unassigns the
issue and returns it to an `unstarted` state. Done moves it to a `completed` state, before
the merge of its ticket branch.

If a Strategy fails, Rippls records the Escalation in its Ledger, unassigns the issue,
returns it to an `unstarted` state, and adds the `needs-human` label. It does not change
the `kind` or `hitl` labels. While the issue has `needs-human`, Rippls does not take it.
`rippls retry` removes the label (see [Retry an escalated ticket](#retry-an-escalated-ticket)).

## Projects and worktrees

Project determines where successful ticket work accumulates:

- With no project, a Ticket Worktree branches from the Repository Root's current
`HEAD`, and success merges back into the Repository Root.
- With a project, Rippls creates or reuses a persistent **Project Worktree** and branch,
then creates Ticket Worktrees from that branch. Successful ticket branches merge
into the project branch.

Worktrees live under `.sandcastle/worktrees/` and are ignored by Git. Project Worktrees
remain for later tickets and are not merged into the Repository Root automatically.
Ticket Worktrees are closed after success and retained after an escalation. A retried
ticket continues in its retained Ticket Worktree, with its commits and uncommitted
changes.

Before a run, keep the branch receiving merges in a reviewable state. Merge or otherwise
integrate a completed project branch yourself.

## Implementation Strategy

An `implementation` ticket runs three steps in the same Ticket Worktree, each through
a separate Harness invocation:

1. **Implement** executes the ticket body with `/implement-bare`.
2. **Gate** runs `/acceptance-gate`, beginning with the repository's typecheck, lint,
  and tests. It has a ten-minute limit and retries once.
3. **Commit** runs `/commit` with a fast, low-tier model.

Each invocation creates a new **Agent**, including a gate retry. The **Runner** remains
the same throughout Ticket Processing and can process further Tickets afterward.

If the configured Harness has no model matching a step's demand, Rippls logs the fallback
and uses that Harness's default model.

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
npx rippls --project api --limit 4 --concurrency 2
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

1. Read the Engine error and `.sandcastle/logs/ticket-<source>-<id>-*.log`.
2. Inspect the retained Ticket Worktree under `.sandcastle/worktrees/`.
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
