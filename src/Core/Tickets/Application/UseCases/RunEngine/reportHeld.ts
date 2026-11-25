import { Console, Effect } from 'effect';

import type { Project } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Project';

import { formatStatusLines, type StatusLine, ticketStatuses } from '../ShowStatus/showStatus';

// A ticket the Engine held back: neither done nor Eligible.
const isHeld = ({ status }: StatusLine) => status !== 'done' && status !== 'eligible';

/**
 * Prints, at the end of a Drain, every ticket the Engine held back, with its Ticket
 * Status and the reason, as `rippls status` prints it.
 */
export const reportHeld = (project?: Project) =>
  Effect.gen(function* () {
    const held = (yield* ticketStatuses({ project })).filter(isHeld);
    if (held.length === 0) {
      return yield* Console.log('No tickets are held back');
    }
    yield* Console.log(`${held.length} ${held.length === 1 ? 'ticket is' : 'tickets are'} held back:`);
    yield* Effect.forEach(formatStatusLines(held), (line) => Console.log(line), { discard: true });
  });
