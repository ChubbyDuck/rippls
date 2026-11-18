import { expect, test } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { renderPrompt } from './promptTemplate';

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

test('renderPrompt leaves any other placeholder as written', () => {
  expect(renderPrompt('Commit {{ticket}} of {{id}} {{valueOf}}', ticket)).toBe('Commit {{ticket}} of folder:auth/7 {{valueOf}}');
});
