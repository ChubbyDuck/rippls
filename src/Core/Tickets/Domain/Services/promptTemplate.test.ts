import { Schema } from 'effect';
import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { PromptTemplate, renderPrompt } from './promptTemplate';

const ticket = Ticket.create({
  id: formatTicketId('folder', 'auth/7'),
  title: 'Add login',
  project: 'web',
  body: 'The body.',
});

test('renderPrompt fills the identity, Title, body, and Project of the ticket', () => {
  expect(renderPrompt('{{id}} | {{ title }} | {{project}}\n{{body}}', ticket)).toBe(
    'folder:auth/7 | Add login | web\nThe body.'
  );
});

test('renderPrompt fills an empty Project for a ticket without one', () => {
  const loose = Ticket.create({ id: formatTicketId('folder', '7'), title: 'Add login', body: '' });

  expect(renderPrompt('/commit {{project}} ticket-{{id}}', loose)).toBe('/commit  ticket-folder:7');
});

test('PromptTemplate accepts the known placeholders and rejects any other', () => {
  const decode = Schema.decodeUnknownResult(PromptTemplate);

  expect(decode('Commit ticket {{id}} of {{project}}: {{title}}\n{{body}}')._tag).toBe('Success');
  expect(decode('Commit ticket {{ticket}} with {{label}}')).toMatchObject({
    _tag: 'Failure',
    failure: {
      message: expect.stringContaining('Unknown placeholder {{ticket}}, {{label}}'),
    },
  });
});
