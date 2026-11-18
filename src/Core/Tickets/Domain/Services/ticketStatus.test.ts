import { describe, expect, it } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { isEligible } from './eligibility';
import { deriveTicketStatus } from './ticketStatus';

const id = (value: number) => formatTicketId('folder', String(value));
const none: ReadonlySet<TicketId> = new Set();
const nothing = { done: none, claimed: none, escalated: none };
const one: ReadonlySet<TicketId> = new Set([id(1)]);

const ticket = (fields: Record<string, unknown> = {}) =>
  Ticket.create({
    id: id(1),
    title: 'Ticket Status',
    kind: 'task',
    hitl: 'no',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
    ...fields,
  });

describe('deriveTicketStatus', () => {
  it('is eligible for an Eligible ticket', () => {
    expect(deriveTicketStatus(ticket(), nothing)).toBe('eligible');
  });

  it('is blocked while a blocker is not done', () => {
    expect(deriveTicketStatus(ticket({ blockedBy: [id(9)] }), nothing)).toBe('blocked');
  });

  it('is not ready for a ticket whose HITL is yes', () => {
    expect(deriveTicketStatus(ticket({ hitl: 'yes' }), nothing)).toBe('not ready');
  });

  it('is claimed for a ticket with a Claim', () => {
    expect(deriveTicketStatus(ticket(), { ...nothing, claimed: one })).toBe('claimed');
  });

  it('is escalated for a ticket with an Escalation', () => {
    expect(deriveTicketStatus(ticket(), { ...nothing, escalated: one })).toBe('escalated');
  });

  it('is done for a done ticket', () => {
    expect(deriveTicketStatus(ticket().done(), nothing)).toBe('done');
  });

  describe('when several values apply, shows the first of done, escalated, claimed, not ready, blocked', () => {
    const notReadyAndBlocked = ticket({ hitl: 'yes', blockedBy: [id(9)] });
    const all = { done: none, claimed: one, escalated: one };

    it('shows done over every other value', () => {
      expect(deriveTicketStatus(notReadyAndBlocked.done(), all)).toBe('done');
    });

    it('shows escalated over claimed, not ready, and blocked', () => {
      expect(deriveTicketStatus(notReadyAndBlocked, all)).toBe('escalated');
    });

    it('shows claimed over not ready and blocked', () => {
      expect(deriveTicketStatus(notReadyAndBlocked, { ...all, escalated: none })).toBe('claimed');
    });

    it('shows not ready over blocked', () => {
      expect(deriveTicketStatus(notReadyAndBlocked, nothing)).toBe('not ready');
    });
  });

  it('is eligible exactly when the eligibility rule holds', () => {
    const tickets = [
      ticket(),
      ticket().done(),
      ticket({ hitl: 'yes' }),
      ticket({ blockedBy: [id(9)] }),
      ticket({ blockedBy: [id(2)] }),
    ];
    const factsList = [
      nothing,
      { ...nothing, done: new Set([id(2)]) },
      { ...nothing, claimed: one },
      { ...nothing, escalated: one },
    ];
    for (const candidate of tickets) {
      for (const facts of factsList) {
        expect(deriveTicketStatus(candidate, facts) === 'eligible').toBe(isEligible(candidate, facts));
      }
    }
  });
});
