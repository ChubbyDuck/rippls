import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotOfSource } from '~/Core/Tickets/Domain/Exceptions/TicketNotOfSource';

import { retrySourceOf } from './retrySource';

const ticket = Schema.decodeSync(TicketId);

const sourceOf = (id: string, asked?: 'folder' | 'linear') =>
  Effect.runSync(retrySourceOf(ticket(id), asked).pipe(Effect.result));

describe('retrySourceOf', () => {
  it('is the Source that the ticket identity names', () => {
    expect(sourceOf('folder:4')).toMatchObject({ _tag: 'Success', success: 'folder' });
    expect(sourceOf('linear:a1b2')).toMatchObject({ _tag: 'Success', success: 'linear' });
  });

  it('accepts the Source asked for when the identity names it', () => {
    expect(sourceOf('linear:a1b2', 'linear')).toMatchObject({ _tag: 'Success', success: 'linear' });
  });

  it('fails when another Source is asked for', () => {
    const outcome = sourceOf('linear:a1b2', 'folder');

    expect(outcome).toMatchObject({
      _tag: 'Failure',
      failure: new TicketNotOfSource({ ticketId: ticket('linear:a1b2'), source: 'folder' }),
    });
    expect(new TicketNotOfSource({ ticketId: ticket('linear:a1b2'), source: 'folder' }).message).toBe(
      'linear:a1b2 is not a ticket of the folder Source'
    );
  });

  it('fails when the identity names no known Source', () => {
    expect(sourceOf('jira:7')).toMatchObject({
      _tag: 'Failure',
      failure: new TicketNotOfSource({ ticketId: ticket('jira:7') }),
    });
    expect(new TicketNotOfSource({ ticketId: ticket('jira:7') }).message).toBe('jira:7 names no known Ticket Source');
  });
});
