import { describe, expect, it } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { doneInSourceIds, isDone, isEligible, isEscalated, isUnattended, isUnblocked, isUnclaimed } from './eligibility';

const id = (value: number) => formatTicketId('folder', String(value));
const none: ReadonlySet<TicketId> = new Set();
const nothing = { done: none, claimed: none, escalated: none };
const doneWith = (...ids: TicketId[]) => ({ ...nothing, done: new Set(ids) });
const claimedOne = { ...nothing, claimed: new Set([id(1)]) };
const escalatedOne = { ...nothing, escalated: new Set([id(1)]) };

const ticket = (fields: Record<string, unknown> = {}) =>
  Ticket.create({
    id: id(1),
    title: 'Eligibility',
    kind: 'task',
    hitl: 'no',
    blockedBy: [],
    body: '',
    ...fields,
  });

const ofKind = (kind: 'implementation' | 'grilling') =>
  Ticket.create({ id: id(1), title: 'Eligibility', kind, blockedBy: [], body: '' });

const blocked = ticket({ blockedBy: [id(9)] });
const attended = ticket({ hitl: 'yes' });

describe('isDone', () => {
  it('holds for a ticket that its Source sees as done', () => {
    expect(isDone(ticket({ doneInSource: true }), none)).toBe(true);
  });

  it('holds for a ticket among the done tickets, such as one the Ledger records as done', () => {
    expect(isDone(ticket(), new Set([id(1)]))).toBe(true);
  });

  it('fails for a ticket that is not done', () => {
    expect(isDone(ticket(), none)).toBe(false);
  });
});

describe('doneInSourceIds', () => {
  it('collects the identities of the tickets that the Source sees as done only', () => {
    const done = ticket({ id: id(2), doneInSource: true });
    expect(doneInSourceIds([ticket(), done, blocked])).toEqual(new Set([id(2)]));
  });
});

describe('isUnblocked', () => {
  it('holds for a ticket with no blockers', () => {
    expect(isUnblocked(ticket(), none)).toBe(true);
  });

  it('fails while a blocker is not done', () => {
    expect(isUnblocked(blocked, none)).toBe(false);
  });

  it('holds once every blocker is done', () => {
    const twoBlockers = ticket({ blockedBy: [id(8), id(9)] });
    expect(isUnblocked(twoBlockers, new Set([id(8), id(9)]))).toBe(true);
  });

  it('fails while one of several blockers is not done', () => {
    const twoBlockers = ticket({ blockedBy: [id(8), id(9)] });
    expect(isUnblocked(twoBlockers, new Set([id(8)]))).toBe(false);
  });

  it('fails for a blocker that the Source cannot find', () => {
    expect(isUnblocked(blocked, doneInSourceIds([ticket({ doneInSource: true })]))).toBe(false);
  });
});

describe('isUnclaimed', () => {
  it('holds for a ticket with no Claim in the Ledger', () => {
    expect(isUnclaimed(ticket(), none)).toBe(true);
  });

  it('fails for a ticket with a Claim in the Ledger', () => {
    expect(isUnclaimed(ticket(), new Set([id(1)]))).toBe(false);
  });

  it('holds while only another ticket has a Claim', () => {
    expect(isUnclaimed(ticket(), new Set([id(2)]))).toBe(true);
  });

  it('ignores a claim field that an earlier Engine wrote into the ticket', () => {
    expect(isUnclaimed(ticket({ claimedBy: 'runner-1' }), none)).toBe(true);
  });
});

describe('isUnattended', () => {
  it('holds for a ticket whose HITL is no', () => {
    expect(isUnattended(ticket())).toBe(true);
  });

  it('fails for a ticket whose HITL is yes', () => {
    expect(isUnattended(attended)).toBe(false);
  });

  it('follows the HITL that a Ticket Kind implies', () => {
    expect(isUnattended(ofKind('implementation'))).toBe(true);
    expect(isUnattended(ofKind('grilling'))).toBe(false);
  });
});

describe('isEscalated', () => {
  it('holds for a ticket that the Ledger records as escalated', () => {
    expect(isEscalated(ticket(), new Set([id(1)]))).toBe(true);
  });

  it('fails for a ticket with no escalation', () => {
    expect(isEscalated(ticket(), none)).toBe(false);
  });
});

describe('isEligible', () => {
  it('holds for an Unblocked, Unclaimed, Unattended ticket', () => {
    expect(isEligible(ticket(), nothing)).toBe(true);
  });

  it('holds for a ticket whose blockers are all done', () => {
    expect(isEligible(blocked, doneWith(id(9)))).toBe(true);
  });

  it('fails for a done ticket', () => {
    expect(isEligible(ticket({ doneInSource: true }), nothing)).toBe(false);
    expect(isEligible(ticket(), doneWith(id(1)))).toBe(false);
  });

  it.each([
    ['blocked', blocked, nothing],
    ['claimed in the Ledger', ticket(), claimedOne],
    ['escalated in the Ledger', ticket(), escalatedOne],
    ['attended', attended, nothing],
  ])('fails for a ticket that is %s', (_, candidate, facts) => {
    expect(isEligible(candidate, facts)).toBe(false);
  });

  it('fails for a ticket that misses every condition', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }), claimedOne)).toBe(false);
  });

  it('fails for a ticket that misses two conditions', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }), nothing)).toBe(false);
    expect(isEligible(ticket({ blockedBy: [id(9)] }), claimedOne)).toBe(false);
  });
});
