# Rippls in one sitting

**What it is:** a CLI (`rippls`) you run inside any Git repo. It pulls tickets from a folder of Markdown files or from Linear, hands each one to a coding-agent CLI (Claude Code, Codex, Cursor, OpenCode) in an isolated Git worktree, then merges the result or escalates to a human. It is about 3,800 lines of TypeScript on Effect 4 (RC), with 5,200 lines of tests. Tests (216), typecheck and lint all pass right now.

## The one flow to hold in your head

```
rippls ──► RunEngine ─────────────────────────────────────────────┐
           spawn N Runners, build a Ticket Stream                 │
                │                                                 │
     poll Source for next Eligible ticket ──► claim in Ledger,    │
     (unblocked + unclaimed + hitl:no)        report `claimed`    │
                │                                                 │
                ▼                                                 │
           ProcessTicket (one Runner, one Ticket)                 │
           1. HarnessSelector picks a Harness (rotation/schedule) │
           2. name the Runner in the Claim                        │
           3. StrategySelector picks a Strategy by Ticket Kind    │
           4. WorktreeManager creates branch `ticket-<src>-<id>`  │
           5. Strategy runs the Harness inside that worktree      │
                │                                                 │
        ┌───────┴────────┐                                        │
     success           failure                                    │
     merge + close     keep worktree, record Escalation           │
     mark `done`,      in Ledger, release Claim, report           │
     release Claim     `escalated`, HALT THE WHOLE ENGINE         │
     (dependents                                                  │
     not edited)                                                  │
                                                                  │
   on exit: release this Engine's Claims, report `released` ◄─────┘
```

## Layout: hexagonal, five ports

The code lives in three places: `src/Core` (domain, use cases and port interfaces, with no infrastructure imports), `src/Infrastructure` (adapters) and `src/config` (config file loading).

| Port (in `Core/**/Ports`) | Adapter(s) | Wraps |
| --- | --- | --- |
| `TicketSource` | [folder.ts](src/Infrastructure/Tickets/TicketSource/folder.ts), [linear.ts](src/Infrastructure/Tickets/TicketSource/linear.ts) | Markdown front matter / Linear GraphQL |
| `StrategySelector` | [default.ts](src/Infrastructure/Tickets/StrategySelector/default.ts) | Kind → Strategy map |
| `HarnessSelector` | [configured.ts](src/Infrastructure/Shared/HarnessSelector/configured.ts), [registered.ts](src/Infrastructure/Shared/HarnessSelector/registered.ts) | Sandcastle agent providers |
| `WorktreeManager` | [sandcastle.ts](src/Infrastructure/Tickets/WorktreeManager/sandcastle.ts) | Sandcastle `createWorktree` + `git merge --no-ff` |
| `Ledger` | [folder.ts](src/Infrastructure/Tickets/Ledger/folder.ts) | One Claim record per ticket in `<git-common-dir>/rippls/ledger/`, Escalations in its `escalations/` folder ([ADR 0004](docs/adr/0004-read-only-tickets-and-the-ledger.md)) |

`Engine` and `Runner` are plain entities with identities and deliberately have no ports; the orchestration lives in the use cases ([ADR 0001](docs/adr/0001-separate-engine-and-runner-from-orchestration.md)).

## Reading path (about 500 lines covers most of it)

1. [CONTEXT.md](CONTEXT.md) is the vocabulary; every name in the code comes from it.
2. [src/index.ts](src/index.ts) defines the CLI flags and wires all the layers together.
3. [runEngine.ts](src/Core/Tickets/Application/UseCases/RunEngine/runEngine.ts) holds the runner pool, the stream, the idle timeout and the release on exit.
4. [processTicket.ts](src/Core/Tickets/Application/UseCases/ProcessTicket/processTicket.ts) is the lifecycle in the diagram above.
5. [entity.ts](src/Core/Tickets/Domain/Entities/Ticket/entity.ts) is the Ticket and its `done` transition. The Claim and the Escalation are not in the Ticket: they live in the Ledger.
6. [implementation.ts](src/Infrastructure/Tickets/StrategySelector/implementation.ts) is the only real Strategy: implement, then gate (10 minutes, one retry), then commit.

After that, read whichever adapter you need. The tests sit next to the source and show the style: fake each port with `Layer.succeed`, as in [processTicket.test.ts](src/Core/Tickets/Application/UseCases/ProcessTicket/processTicket.test.ts).

## Things that will surprise you

- **Your local `rippls.config.ts` is silently ignored.** It exports `harnessFileConfig` with an `agents` key, but [load.ts:26-31](src/config/load.ts#L26-L31) only reads `engineFileConfig` or `default`. Runs in this repo therefore use the defaults: all four Harnesses in rotation and no tracing, not Cursor only with OTLP.
- **Eligibility ignores status.** The poll query is unblocked + unclaimed + not escalated + `hitl: no`, so a folder ticket with `status: open` and no blockers gets picked up. Unblocked means every blocker is done, so a `status: blocked` ticket whose blockers are in `done/` is taken too.
- **One Strategy failure stops the run.** `EngineHalted` propagates out of the stream, and a worktree create or merge failure does the same after one retry.
- **Only `implementation` is real.** `research` and `task` are a single Harness call via `named()` in [noop.ts](src/Infrastructure/Tickets/StrategySelector/noop.ts); `prototype` and `grilling` imply `hitl: yes`, so they are never taken.
- **The implementation Strategy depends on things outside this repo.** It sends `/implement-bare`, `/acceptance-gate` and `/commit`, which must exist as slash commands in the target repo's Harness. [circumstances.ts](src/Infrastructure/Tickets/StrategySelector/circumstances.ts) also tells agents to use `pnx chubby <alias> <script>`, a leftover from the monorepo this was extracted from.
- **Hidden coupling between two adapters.** The Harness adapter looks up the Sandcastle worktree handle by path in a module-level `Map` owned by the WorktreeManager adapter ([registered.ts:124-128](src/Infrastructure/Shared/HarnessSelector/registered.ts#L124-L128)). A `cwd` with no registered handle fails with `HarnessRuntimeError`.
- **Model IDs are hard-coded.** The catalog is in [registered.ts:23-53](src/Infrastructure/Shared/HarnessSelector/registered.ts#L23-L53); a Strategy asks for a tier/fast/generation and falls back to the Harness default when nothing matches.
- **A Claim from another host is never stale.** The Engine replaces a Claim whose process no longer runs on its own host, but it cannot see the processes of another host, so such a Claim keeps its ticket claimed until someone removes the Ledger record.
- **Ticket IDs are namespaced strings** (`folder:42`, `linear:<uuid>`), and the domain never branches on the source ([ADR 0002](docs/adr/0002-source-namespaced-string-ticket-id.md)). On disk the folder Source still uses plain numbers.
- **Loose ends:**
  - `TicketQuery.afk()` uses a term CONTEXT.md says to avoid (it should be "Unattended").
  - `_pollTicketTraced`, `StrategySelectorNoop` and [random.ts](src/Infrastructure/Tickets/TicketSource/random.ts) are not referenced by any non-test source file.
  - `ProcessTicketCommand.repositoryRoot` is passed but never read.
  - The version `0.0.2` is duplicated in four places.

## Working here

- **Commands:** `pnpm start` runs the CLI from source, and `pnpm test`, `pnpm typecheck` and `pnpm lint` are what CI runs. `pnpm generate` creates fixture tickets in `.agents/tickets`; `pnpm clean-tickets` deletes every numbered ticket file there, hand-written ones included.
- **Build:** `pnpm build` bundles to `dist/rippls.js` with Vite. `@effect/platform-node` is bundled in on purpose so fresh installs cannot drift from the pinned Effect RC.
- **Effect 4 RC:** the APIs differ from v3 (`Context.Service`, `Effect.fn`, `Schema.decodeTo`). Read them from your local fork at `~/_Projects/fork/effect`, and Sandcastle from `~/_Projects/fork/sandcastle`.
- **House rules ([AGENTS.md](AGENTS.md)):** one concern per turn, implement only what was asked, pipes until they get hard to read and `Effect.gen` after that.
- **Runtime state:** `.sandcastle/worktrees/`, `.sandcastle/logs/<label>.log` (full Harness output) and `.agents/tickets/` are all gitignored.