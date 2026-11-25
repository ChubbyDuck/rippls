import { Console, Effect, Result } from 'effect';

import { defaultCheckConfig, defaultCommitConfig } from '~/Core/Shared/Domain/EngineConfig';
import type { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';
import { HarnessSelector } from '~/Core/Shared/Ports/HarnessSelector';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { EngineHalted } from '~/Core/Tickets/Domain/Exceptions/EngineHalted';
import type { WorktreeCommandError } from '~/Core/Tickets/Domain/Exceptions/WorktreeCommandError';
import { Ledger } from '~/Core/Tickets/Ports/Ledger';
import { StrategySelector } from '~/Core/Tickets/Ports/StrategySelector';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';
import { type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

import { checkTicketWorktree } from './checkTicketWorktree';
import { commitTicketWorktree } from './commitTicketWorktree';
import { harnessInWorktree } from './harnessInWorktree';
import type { ProcessTicketCommand } from './command';
import { prepareTicketWorktree } from './prepareTicketWorktree';

// A failed ticket keeps its content. The Ledger records the Escalation with the
// retained Ticket Worktree, the Source hears escalated, and only then is the Claim
// released. A report that fails is logged, and the Claim stays: the exit that
// follows the halt reports escalated again, and a later Engine that meets the
// record finishes it. The Engine then halts. In place, the work is in the
// Repository Root itself: there is no Ticket Worktree to retain, so the Escalation
// records no path, and the tree is left as it is.
const escalate = (ticket: Ticket, worktree: Worktree, repositoryRoot: string, reason: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const source = yield* TicketSource;
    const inPlace = worktree.path === repositoryRoot;
    const escalation = yield* ledger.escalate(ticket.id, inPlace ? { reason } : { reason, worktree: worktree.path });
    const kept = inPlace
      ? `its work stays in the Repository Root at ${worktree.path} as it is`
      : `its Ticket Worktree is retained at ${worktree.path}`;
    yield* Console.error(
      `${ticket.label} failed (${reason}) and is escalated after ${escalation.attempts} attempt(s); ${kept}`
    );
    yield* source.report(ticket.id, 'escalated').pipe(
      Effect.andThen(ledger.release(ticket.id)),
      Effect.catchTag('TicketEventNotReported', (error) =>
        Console.error(`Failed to report the escalation of ticket ${ticket.id}, so its Claim stays in the Ledger`, error)
      )
    );
    return yield* new EngineHalted({ ticketId: ticket.id, reason });
  });

// A ticket is done exactly when its work has landed. The Source hears done before
// the merge, so what it changes in the Ticket Worktree lands with the work; a
// report that fails is a failure of Ticket Processing. A failed merge halts the
// Engine with no done in the Ledger. Once the merge succeeds, the Ledger records
// done, the Source finishes what it could not do before the merge, and only then
// is the Claim released. A failure after the merge does not undo the work: it is
// logged, and the Claim stays, so the exit that follows completes the ticket on the
// Source again, and a later Engine that meets the record finishes it. In place,
// the merge does nothing: the work and the done move are already on the current
// branch.
const landDone = (ticket: Ticket, worktree: Worktree, repositoryRoot: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const source = yield* TicketSource;
    const worktrees = yield* WorktreeManager;
    const afterMerge = yield* source
      .reportDone(ticket.id, worktree)
      .pipe(Effect.catchTag('TicketEventNotReported', () => escalate(ticket, worktree, repositoryRoot, 'done report failure')));
    yield* Effect.suspend(() =>
      Console.log(`${ticket.label} is merging worktree ${worktree.branch}`).pipe(
        Effect.andThen(worktrees.mergeAndClose(worktree))
      )
    ).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchTag('WorktreeCloseError', () =>
        Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: 'worktree close failure' }))
      )
    );
    yield* ledger.recordDone(ticket.id);
    yield* Console.log(`${ticket.label} is done`);
    yield* afterMerge.pipe(
      Effect.andThen(ledger.release(ticket.id)),
      Effect.catchTag('TicketEventNotReported', (error) =>
        Console.error(
          `${ticket.label} could not be completed on the Source after the merge, so its Claim stays in the Ledger`,
          error
        )
      )
    );
  });

// A step after the Strategy that the Worktree Manager or the Harness cannot carry
// out fails as its post-condition does: the error is logged and the step yields false.
const failingOn =
  (messages: { readonly worktree: string; readonly harness: string }) =>
  <R>(step: Effect.Effect<boolean, WorktreeCommandError | HarnessRuntimeError, R>) =>
    step.pipe(
      Effect.catchTags({
        WorktreeCommandError: () => Console.error(messages.worktree).pipe(Effect.as(false)),
        HarnessRuntimeError: () => Console.error(messages.harness).pipe(Effect.as(false)),
      })
    );

export const processTicket = ({
  ticket,
  runnerId,
  repositoryRoot,
  check = defaultCheckConfig,
  commit = defaultCommitConfig,
}: ProcessTicketCommand) =>
  Effect.gen(function* () {
    const harnessSelector = yield* HarnessSelector;
    const harness = yield* harnessSelector.select;
    yield* Effect.annotateCurrentSpan('harness', harness.name);
    const ledger = yield* Ledger;
    const strategies = yield* StrategySelector;
    yield* ledger.assignRunner(ticket.id, runnerId).pipe(Effect.withSpan('runner.claim'));
    const strategy = yield* strategies.select(ticket.kind);
    yield* Effect.annotateCurrentSpan('strategy', strategy.name);
    yield* Console.log(
      `${ticket.label} is processed by '${strategy.name}' strategy and '${harness.name}' harness using '${harness.model}'`
    );
    // A directory that is not the expected worktree stays so: it gets no second
    // try, no Agent runs in it, and the halt names what was found.
    const worktree = yield* prepareTicketWorktree({ ticket }).pipe(
      Effect.retry({ times: 1, while: (error) => error._tag === 'WorktreeCreationError' }),
      Effect.catchTags({
        WorktreeCreationError: () =>
          Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: 'worktree creation failure' })),
        WorktreeNotExpected: (error) => Effect.fail(new EngineHalted({ ticketId: ticket.id, reason: error.message })),
      })
    );
    // Only the Worktree Manager knows the branch, so the preparation is logged once it returns.
    yield* Console.log(`${ticket.label} prepared worktree ${worktree.branch} from ${ticket.project ?? 'HEAD'}`);
    yield* Console.log(`${ticket.label} is opening worktree ${worktree.branch} at ${worktree.path}`);
    const worktreeHarness = harnessInWorktree(harness, worktree.path);
    const outcome = yield* strategy
      .run(ticket, worktreeHarness)
      .pipe(Effect.withSpan('strategy.run', { attributes: { harness: harness.name, strategy: strategy.name } }));
    if (Result.isFailure(outcome)) {
      return yield* escalate(ticket, worktree, repositoryRoot, outcome.failure.message);
    }
    // A check command that cannot run, or a fix the Harness cannot carry out, fails
    // the check as a failing command does.
    const passed = yield* checkTicketWorktree(ticket, worktree, worktreeHarness, check).pipe(
      failingOn({
        worktree: `${ticket.label} could not run its check command`,
        harness: `${ticket.label} could not send the fix prompt to the Harness`,
      })
    );
    if (!passed) {
      return yield* escalate(ticket, worktree, repositoryRoot, 'check failure');
    }
    // The commit is a post-condition: a worktree still dirty after the commit
    // prompt, one whose state cannot be read, or a commit prompt the Harness fails
    // on fails Ticket Processing as a failed check does, with no fix attempt.
    const committed = yield* commitTicketWorktree(ticket, worktree, worktreeHarness, commit).pipe(
      failingOn({
        worktree: `${ticket.label} could not read whether its worktree is clean`,
        harness: `${ticket.label} could not send the commit prompt to the Harness`,
      })
    );
    if (!committed) {
      return yield* escalate(ticket, worktree, repositoryRoot, 'commit failure');
    }
    yield* landDone(ticket, worktree, repositoryRoot);
  }).pipe(
    Effect.withSpan('runner.run', {
      attributes: {
        'ticket.id': ticket.id,
        'ticket.kind': ticket.kind,
        'runner.id': runnerId,
      },
    })
  );
