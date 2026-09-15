# Rippls

![A duck creating concentric ripples on a calm pond](docs/assets/pond-ripple-hero.jpg)

Rippls is an opinionated ticket workflow engine. It defines a ticket format, lifecycle
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
| **Ticket Source** | Reads external records, converts them into Tickets, and saves Ticket changes. |
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

1. Acquires the next eligible **Ticket** through the **Ticket Stream**, which polls the configured **Source**.
2. Claims it for a stable, named **Runner**.
3. Selects a configured **Harness**.
4. Creates a `ticket-<source>-<id>` branch and **Ticket Worktree**.
5. Installs workspace dependencies with `corepack pnpm install` when needed.
6. Runs the selected **Strategy**, which invokes the **Harness** to create Agents for its steps.
7. On success, merges the ticket branch and marks the ticket `done`.
8. On Strategy failure, retains the worktree and raises the ticket to a human as
  `kind: task`, `hitl: yes`.

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

The completed ticket moves to `.agents/tickets/done/`. Because this example has a
project, its ticket branch is merged into the persistent `health-endpoint` project
branch. Review that branch and merge it into your main branch when ready.

## Which tickets are eligible?

A ticket is **Eligible** when all three conditions hold:

- **Unblocked**: `blockedBy` is empty.
- **Unclaimed**: it has no Runner and is not currently being claimed.
- **Unattended**: `hitl` is `no`.

Eligibility does not mean “every ticket with `status: ready-for-agent`.” The Source
status is still used for lifecycle updates, but polling applies the conditions above.

Folder tickets are ordered by the numeric filename prefix, lowest first. Linear tickets
are ordered by creation time, oldest first. `--project` narrows the poll to one project.

## Ticket kinds and HITL

Every ticket has one kind. Most kinds imply whether a human must be in the loop:

- `implementation` implies `hitl: no`.
- `research` implies `hitl: no`.
- `prototype` implies `hitl: yes`.
- `grilling` implies `hitl: yes`.
- `task` must explicitly set `hitl: no` or `hitl: yes`.

Only `implementation` currently has the full implement, acceptance-gate, and commit
workflow. `research` and an unattended `task` invoke the Harness once and then complete;
they do not run that three-stage workflow. `prototype` and `grilling` imply
`hitl: yes`, so the Engine does not claim them.

## Running the Engine

```text
rippls [flags]
```

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

Use `Ctrl-C` to stop a run. On normal finalization Rippls attempts to return claimed
tickets in the selected project to `ready-for-agent`.

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
},
```



### File naming

Ticket files live directly inside `ticketsDir` and match `<numeric-id>*.md`, for example:

```text
1.md
2-add-login.md
003_document-api.md
```

The numeric filename prefix is authoritative. Rippls writes `id` into front matter,
but reads the ID from the filename.

### Front matter

Every folder ticket needs:

- a non-empty, trimmed `title`
- a valid `status`
- a valid `kind`
- `blockedBy` and `blocks` arrays containing numeric folder ticket IDs
- `hitl` only when `kind` is `task`

`project` is optional. The Markdown after front matter is the prompt passed to the
Strategy.

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

When ticket 12 completes, Rippls removes `12` from ticket 13's `blockedBy`; when no
blockers remain, ticket 13 becomes `ready-for-agent`.

Completed files move to `ticketsDir/done/`. Invalid files and files without valid front
matter are skipped.

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

Rippls recognizes a Linear issue only when it has exactly one supported `kind:*` label:

```text
kind:implementation
kind:research
kind:prototype
kind:grilling
kind:task
```

Tasks also need exactly one of:

```text
hitl:no
hitl:yes
```

Issue data maps into tickets as follows:

- The Linear issue ID becomes the Source-scoped ticket ID.
- The title and description become the ticket title and body.
- The Linear project name becomes a lowercase, hyphenated project.
- Linear `blocks` relations become `blockedBy` and `blocks`.
- `unstarted` workflow states map to `ready-for-agent`.
- `started` states map to `claimed`.

The Linear Source currently reads issues in `unstarted` and `started` states. Claiming
assigns the issue to the API-key user and moves it to a `started` state. Completion
moves it to a `completed` state.

If a Strategy fails, Rippls unassigns the issue, returns it to an `unstarted` state,
and changes its grouped labels to `kind:task` and `hitl:yes` when those labels exist.

## Projects and worktrees

Project determines where successful ticket work accumulates:

- With no project, a Ticket Worktree branches from the Repository Root's current
`HEAD`, and success merges back into the Repository Root.
- With a project, Rippls creates or reuses a persistent **Project Worktree** and branch,
then creates Ticket Worktrees from that branch. Successful ticket branches merge
into the project branch.

Worktrees live under `.sandcastle/worktrees/` and are ignored by Git. Project Worktrees
remain for later tickets and are not merged into the Repository Root automatically.
Ticket Worktrees are closed after success and retained after a HITL raise.

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
- `--status <status>` restricts statuses.
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
3. Resolve the raised `task` with `hitl: yes`.
4. Return it to unattended processing only after the problem is addressed.



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
