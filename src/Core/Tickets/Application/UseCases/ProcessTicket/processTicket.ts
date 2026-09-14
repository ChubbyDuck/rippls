import { Console, Effect, Result } from 'effect';

import { AgentRepository } from '~/Core/Shared/Ports/AgentRepository';
import { HarnessHalted } from '~/Core/Tickets/Domain/Exceptions/HarnessHalted';
import { StrategyRepository } from '~/Core/Tickets/Ports/StrategyRepository';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';
import { WorktreeRepository } from '~/Core/Tickets/Ports/WorktreeRepository';

import { completeTicket } from '../CompleteTicket/completeTicket';

import { anchoredAgent } from './anchoredAgent';
import type { ProcessTicketCommand } from './command';
import { resolveAnchor } from './resolveAnchor';

export const processTicket = ({ ticket, runnerId }: ProcessTicketCommand) =>
  Effect.gen(function* () {
    const agentRepository = yield* AgentRepository;
    const agent = yield* agentRepository.getOne;
    yield* Effect.annotateCurrentSpan('agent', agent.name);
    yield* Console.log(`${ticket.label} is claimed`);
    const repo = yield* TicketRepository;
    const strategies = yield* StrategyRepository;
    const worktrees = yield* WorktreeRepository;
    const claimedTicket = ticket.claim({ by: runnerId });
    yield* repo.save(claimedTicket).pipe(Effect.withSpan('runner.claim'));
    const strategy = yield* strategies.getOneBy(claimedTicket.kind);
    yield* Effect.annotateCurrentSpan('strategy', strategy.name);
    yield* Console.log(
      `${ticket.label} is processed by '${strategy.name}' strategy and '${agent.name}' agent using '${agent.model}'`
    );
    yield* Console.log(
      claimedTicket.project === undefined
        ? `${ticket.label} is preparing worktree ticket-${claimedTicket.id} from HEAD`
        : `${ticket.label} is preparing worktree ticket-${claimedTicket.id} from ${claimedTicket.project}`
    );
    const worktree = yield* resolveAnchor({ ticket: claimedTicket }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchTag('WorktreeCreationError', () =>
        Effect.fail(new HarnessHalted({ ticketId: claimedTicket.id, reason: 'worktree creation failure' }))
      )
    );
    yield* Console.log(`${ticket.label} is opening worktree ${worktree.branch} at ${worktree.path}`);
    const outcome = yield* strategy
      .run(claimedTicket, anchoredAgent(agent, worktree.path))
      .pipe(Effect.withSpan('strategy.run', { attributes: { agent: agent.name, strategy: strategy.name } }));
    yield* Result.match(outcome, {
      onSuccess: () =>
        Effect.suspend(() =>
          Console.log(`${ticket.label} is merging worktree ${worktree.branch}`).pipe(
            Effect.andThen(worktrees.close(worktree))
          )
        ).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchTag('WorktreeCloseError', () =>
            Effect.fail(new HarnessHalted({ ticketId: claimedTicket.id, reason: 'worktree close failure' }))
          ),
          Effect.andThen(Console.log(`${ticket.label} is done`)),
          Effect.andThen(completeTicket({ ticketId: claimedTicket.id }))
        ),
      onFailure: () =>
        Console.error(`${ticket.label} failed and is raised to a human`).pipe(
          Effect.andThen(repo.save(claimedTicket.escalate())),
          Effect.andThen(Effect.fail(new HarnessHalted({ ticketId: claimedTicket.id, reason: 'strategy failure' })))
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
