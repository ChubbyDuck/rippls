import { Console, Effect, Result } from 'effect';

import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { completeTicket } from '../CompleteTicket/completeTicket';

import { harnessInWorktree } from './harnessInWorktree';
import type { ProcessTicketCommand } from './command';
import { prepareTicketWorktree } from './prepareTicketWorktree';

// A failed ticket keeps its content. The Ledger records the escalation with the
// retained Ticket Worktree, the Claim is released, and the Source hears escalated.
// A report that fails is only logged, since the Ledger holds the escalation. The
// Engine then halts.
const escalate = (ticket: Ticket, worktree: Worktree, reason: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const source = yield* TicketSource;
    yield* Console.error(`${ticket.label} failed and is raised to a human`);
    const escalation = yield* ledger.escalate(ticket.id, { reason, worktree: worktree.path });
    yield* Console.error(
      `${ticket.label} is escalated after ${escalation.attempts} attempt(s), its worktree is retained at ${worktree.path}`
    );
    yield* ledger.release(ticket.id);
    yield* source
      .report(ticket.id, 'escalated')
      .pipe(Effect.catch((error) => Console.error(`Failed to report the escalation of ticket ${ticket.id}`, error)));
    return yield* new EngineHalted({ ticketId: ticket.id, reason });
  });

export const processTicket = ({ ticket, runnerId }: ProcessTicketCommand) =>
  Effect.gen(function* () {
    const harnessSelector = yield* HarnessSelector;
    const harness = yield* harnessSelector.select;
    yield* Effect.annotateCurrentSpan('harness', harness.name);
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
      onFailure: () => escalate(ticket, worktree, 'strategy failure'),
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
