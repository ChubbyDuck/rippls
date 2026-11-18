import { Console, Effect, Result } from 'effect';

import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { completeTicket } from '../CompleteTicket/completeTicket';

import { harnessInWorktree } from './harnessInWorktree';
import type { ProcessTicketCommand } from './command';
import { prepareTicketWorktree } from './prepareTicketWorktree';

export const processTicket = ({ ticket, runnerId }: ProcessTicketCommand) =>
  Effect.gen(function* () {
    const harnessSelector = yield* HarnessSelector;
    const harness = yield* harnessSelector.select;
    yield* Effect.annotateCurrentSpan('harness', harness.name);
    const source = yield* TicketSource;
    const ledger = yield* Ledger;
    const strategies = yield* StrategySelector;
    const worktrees = yield* WorktreeManager;
    yield* ledger.assignRunner(ticket.id, runnerId).pipe(Effect.withSpan('runner.claim'));
    const strategy = yield* strategies.select(ticket.kind);
    yield* Effect.annotateCurrentSpan('strategy', strategy.name);
    yield* Console.log(
      `${ticket.label} is processed by '${strategy.name}' strategy and '${harness.name}' harness using '${harness.model}'`
    );
    yield* Console.log(
      ticket.project === undefined
        ? `${ticket.label} is preparing worktree ticket-${ticket.id} from HEAD`
        : `${ticket.label} is preparing worktree ticket-${ticket.id} from ${ticket.project}`
    );
    const worktree = yield* prepareTicketWorktree({ ticket }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchTag('WorktreeCreationError', () =>
        Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: 'worktree creation failure' }))
      )
    );
    yield* Console.log(`${ticket.label} is opening worktree ${worktree.branch} at ${worktree.path}`);
    const outcome = yield* strategy
      .run(ticket, harnessInWorktree(harness, worktree.path))
      .pipe(Effect.withSpan('strategy.run', { attributes: { harness: harness.name, strategy: strategy.name } }));
    yield* Result.match(outcome, {
      onSuccess: () =>
        Effect.suspend(() =>
          Console.log(`${ticket.label} is merging worktree ${worktree.branch}`).pipe(
            Effect.andThen(worktrees.mergeAndClose(worktree))
          )
        ).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchTag('WorktreeCloseError', () =>
            Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: 'worktree close failure' }))
          ),
          Effect.andThen(Console.log(`${ticket.label} is done`)),
          Effect.andThen(completeTicket({ ticketId: ticket.id })),
          Effect.andThen(ledger.release(ticket.id))
        ),
      onFailure: () =>
        Console.error(`${ticket.label} failed and is raised to a human`).pipe(
          Effect.andThen(source.save(ticket.escalate())),
          Effect.andThen(Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: 'strategy failure' })))
        ),
    });
  }).pipe(
    Effect.withSpan('runner.run', {
      attributes: {
        'ticket.id': ticket.id,
        'ticket.kind': ticket.kind,
        'runner.id': runnerId,
      },
    })
  );
