# Rippls in one sitting

**What it is:** a CLI (`rippls`) you run inside any Git repo. It pulls tickets from a folder of Markdown files or from Linear, hands each one to a coding-agent CLI (Claude Code, Codex, Cursor, OpenCode) in its Workspace, then lands the result or escalates to a human. The Workspace is in place by default: the Repository Root on its current branch, with nothing to merge. With `workspace: worktree`, it is an isolated Git worktree that is merged on success ([ADR 0005](docs/adr/0005-in-place-workspace-by-default.md)). It is about 5,900 lines of TypeScript on Effect 4 (RC), with 10,700 lines of tests. Tests (533), typecheck and lint all pass right now.

## The one flow to hold in your head

```
rippls ──► RunEngine ────────────────────────────────────────────────────┐
           spawn N Runners, build a Ticket Stream                         │
                │                                                         │
     poll Source; the eligibility rule    claim in Ledger, or             │
     picks an Eligible ticket:        ──► replace a Stale Claim;          │
     unblocked + unclaimed + hitl:no      report `claimed`                │
     + not escalated + not done                                           │
                │                                                         │
                ▼                                                         │
           ProcessTicket (one Runner, one Ticket)                         │
           1. HarnessSelector picks a Harness (rotation/schedule)         │
           2. name the Runner in the Claim                                │
           3. StrategySelector picks the Strategy of the Ticket Kind      │
           4. WorktreeManager prepares the Workspace: in place, the       │
              Repository Root; else branch `ticket-<src>-<id>`            │
           5. Strategy runs its configured steps in that Workspace        │
              (a verdict step must end with the pass signal)              │
           6. check command; when it fails, the fix prompt,               │
              up to the fix attempts                                      │
           7. commit: a dirty worktree gets the commit prompt             │
                │                                                         │
        ┌───────┴────────┐                                                │
     success           failure of a step, the check, the commit,          │
     report `done`     or the done report:                                │
     (folder: move     keep worktree, record Escalation in                │
     into done/),      Ledger, report `escalated`,                        │
     merge + close,    release Claim once it succeeds,                    │
     record done in    HALT THE WHOLE ENGINE                              │
     Ledger, finish                                                       │
     done on the                                                          │
     Source, release                                                      │
     Claim once that                                                      │
     succeeds                                                             │
                                                                          │
   on exit: report the end state the Ledger shows (`done`, ◄─────────────┘
   `escalated`, else `released`) for this Engine's Claims, and remove
   each record once its report succeeds (else it stays: a Stale Claim,
   which the next Engine finishes)
```

The Ledger in `<git-common-dir>/rippls/ledger/` holds every Claim, the Escalations in `escalations/`, the cleared ones in `cleared/`, and done in `done/`. Its `replacing/` folder holds, per ticket, the new Claim of the one caller that is replacing its Stale Claim. `rippls status` reads it with the Source and changes nothing; `rippls retry <ticket>` reports `retried` and moves the Escalation into `cleared/`, and the next Ticket Processing of the ticket continues in its retained Ticket Worktree. In place, merge and close does nothing, the done move is a commit on the current branch (or a plain move when Git does not track the ticket), and an Escalation keeps no worktree: it records no path, and a retry leaves the tree as it is.

## Layout: hexagonal, nine ports

The code lives in three places: `src/Core` (domain, use cases and port interfaces, with no infrastructure imports), `src/Infrastructure` (adapters) and `src/config` (config file loading: the user config merged under the repository config, and the nearest-queue lookup of the folder Source).

| Port (in `Core/**/Ports`) | Adapter(s) | Wraps |
| --- | --- | --- |
| `TicketSource` | [folder.ts](src/Infrastructure/Tickets/TicketSource/folder.ts), [linear.ts](src/Infrastructure/Tickets/TicketSource/linear.ts) | Markdown front matter / the Linear issues of a team (through `LinearApi`) |
| `LinearApi` | [live.ts](src/Infrastructure/Tickets/LinearApi/live.ts) | The Linear SDK: team metadata, issues, and the state, assignee, labels, and relations of an issue. Only the Linear `TicketSource` uses it |
| `StrategySelector` | [configured.ts](src/Infrastructure/Tickets/StrategySelector/configured.ts) | Kind → Strategy of configured steps (`strategies` in config, defaults in [EngineConfig.ts](src/Core/Shared/Domain/EngineConfig.ts)) |
| `Strategy` | [configured.ts](src/Infrastructure/Tickets/StrategySelector/configured.ts) (`configuredStrategy`) | What `StrategySelector` returns: its steps run in order through a Harness, with the outcome as a `Result` |
| `HarnessSelector` | [configured.ts](src/Infrastructure/Shared/HarnessSelector/configured.ts) | The rotation, weighted by priority, and the schedule of Harnesses from config |
| `Harness` | [registered.ts](src/Infrastructure/Shared/HarnessSelector/registered.ts) | Sandcastle agent providers, the model catalog, and the keys of the Repository Root's `.sandcastle/.env` |
| `WorktreeManager` | [inPlace.ts](src/Infrastructure/Tickets/WorktreeManager/inPlace.ts), [sandcastle.ts](src/Infrastructure/Tickets/WorktreeManager/sandcastle.ts) | In place (the default `workspace`): the Repository Root on its current branch, no merge, and `git status --porcelain` that ignores untracked files under the tickets folder. Ticket Worktrees: Sandcastle `createWorktree` + `git merge --no-ff`, and `git status --porcelain` for a clean worktree. Both run the check command through a shell |
| `Ledger` | [folder.ts](src/Infrastructure/Tickets/Ledger/folder.ts) | One Claim record per ticket in `<git-common-dir>/rippls/ledger/`, Escalations in its `escalations/` folder, cleared ones in `cleared/`, done in `done/`, and the replace of a Stale Claim in `replacing/` ([ADR 0004](docs/adr/0004-read-only-tickets-and-the-ledger.md)) |
| `FixtureWriter` | [folder.ts](src/Infrastructure/Tickets/FixtureWriter/folder.ts) | The fixture ticket files of `pnpm generate`. Only the generator uses it |

`Engine` and `Runner` are plain entities with identities and deliberately have no ports; the orchestration lives in the use cases ([ADR 0001](docs/adr/0001-separate-engine-and-runner-from-orchestration.md)).

## Reading path (about 500 lines covers most of it)

1. [CONTEXT.md](CONTEXT.md) is the vocabulary; every name in the code comes from it.
2. [src/index.ts](src/index.ts) defines the CLI flags and wires all the layers together.
3. [runEngine.ts](src/Core/Tickets/Application/UseCases/RunEngine/runEngine.ts) holds the runner pool, the stream, the idle timeout and the end of each Claim on exit.
4. [processTicket.ts](src/Core/Tickets/Application/UseCases/ProcessTicket/processTicket.ts) is the lifecycle in the diagram above.
5. [entity.ts](src/Core/Tickets/Domain/Entities/Ticket/entity.ts) is the Ticket: an identity, a Title, and a body, with every other field read as a hint with a fallback. It has no transitions: the Claim, the Escalation, and done live in the Ledger, and done also in the Source.
6. [configured.ts](src/Infrastructure/Tickets/StrategySelector/configured.ts) runs a Strategy: its configured steps in order, each with its own prompt, model demand, time limit, retries, and optional verdict.

After that, read whichever adapter you need. The tests sit next to the source and show the style: fake each port with `Layer.succeed`, as in [processTicket.test.ts](src/Core/Tickets/Application/UseCases/ProcessTicket/processTicket.test.ts).

## Things that will surprise you

- **Your local `rippls.config.ts` is silently ignored.** It exports `harnessFileConfig` with an `agents` key, but [load.ts:23-28](src/config/load.ts#L23-L28) only reads `engineFileConfig` or `default`. Runs in this repo therefore use the defaults: all four Harnesses in rotation and no tracing, not Cursor only with OTLP.
- **Eligibility reads `status` only as a Marker.** The one rule in [eligibility.ts](src/Core/Tickets/Domain/Services/eligibility.ts) is unblocked + unclaimed + not escalated + not done + `hitl: no`. A `status` of `ready-for-agent` means HITL no and `ready-for-human` HITL yes, unless the ticket states its `hitl`; any other `status` is ignored, so a `hitl: no` ticket with `status: blocked` is taken once every blocker is done.
- **One Escalation stops the run.** A failed Strategy step, check, commit, or done report escalates the ticket, and `EngineHalted` propagates out of the stream. A worktree create or merge failure, after one retry, and a Ticket Kind with no Strategy (`StrategyNotFound`) halt the run too, without an Escalation.
- **`prototype` and `grilling` have no default Strategy.** They imply `hitl: yes`, so they are not taken unless a ticket says `hitl: no`; then the run stops with `StrategyNotFound` unless config gives the kind a Strategy.
- **Model IDs are hard-coded.** The catalog is in [registered.ts:22-52](src/Infrastructure/Shared/HarnessSelector/registered.ts#L22-L52); a Strategy asks for a tier/fast/generation and falls back to the Harness default when nothing matches.
- **A Claim from another host is never stale.** The Engine replaces a Claim whose process no longer runs on its own host, but it cannot see the processes of another host, so such a Claim keeps its ticket claimed until someone removes the Ledger record.
- **Ticket IDs are namespaced strings** (`folder:42`, `folder:auth/3`, `linear:<uuid>`), and the domain never branches on the source ([ADR 0002](docs/adr/0002-source-namespaced-string-ticket-id.md)). A folder ticket's identity is its folder below the tickets folder plus the number of its filename prefix, so renaming the slug keeps it, and moving the file to another folder or renumbering it makes a new ticket.
- **Loose ends:**
  - `StrategySelectorNoop` is not referenced by any non-test source file.
  - The version `0.0.2` is duplicated in four places.

## Working here

- **Commands:** `pnpm start` runs the CLI from source, and `pnpm test`, `pnpm typecheck` and `pnpm lint` are what CI runs. `pnpm generate` creates fixture tickets in `.agents/tickets`; `pnpm clean-tickets` deletes every numbered ticket file there, hand-written ones included.
- **Build:** `pnpm build` bundles to `dist/rippls.js` with Vite. `@effect/platform-node` is bundled in on purpose so fresh installs cannot drift from the pinned Effect RC.
- **Effect 4 RC:** the APIs differ from v3 (`Context.Service`, `Effect.fn`, `Schema.decodeTo`). Read them from your local fork at `~/_Projects/fork/effect`, and Sandcastle from `~/_Projects/fork/sandcastle`.
- **House rules ([AGENTS.md](AGENTS.md)):** one concern per turn, implement only what was asked, pipes until they get hard to read and `Effect.gen` after that.
- **Runtime state:** `.sandcastle/worktrees/`, `.sandcastle/logs/<label>.log` (full Harness output) and `.agents/tickets/` are all gitignored.