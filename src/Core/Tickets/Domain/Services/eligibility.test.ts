import { describe, expect, it } from 'vitest';

import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { doneTicketIds, isDone, isEligible, isUnattended, isUnblocked, isUnclaimed } from './eligibility';

const id = (value: number) => formatTicketId('folder', String(value));
const runner = 'runner-1' as RunnerId;
const none: ReadonlySet<TicketId> = new Set();

const ticket = (fields: Record<string, unknown> = {}) =>
  Ticket.create({
    id: id(1),
    title: 'Eligibility',
    kind: 'task',
    hitl: 'no',
    status: 'ready-for-agent',
    blockedBy: [],
    blocks: [],
    body: '',
    ...fields,
  });

const ofKind = (kind: 'implementation' | 'grilling') =>
  Ticket.create({ id: id(1), title: 'Eligibility', kind, status: 'ready-for-agent', blockedBy: [], blocks: [], body: '' });

const blocked = ticket({ blockedBy: [id(9)] });
const claiming = ticket().markClaiming();
const claimed = ticket().claim({ by: runner });
const attended = ticket({ hitl: 'yes' });

describe('isDone', () => {
  it('holds for a done ticket', () => {
    expect(isDone(ticket().done())).toBe(true);
  });

  it('fails for a ticket that is not done', () => {
    expect(isDone(ticket())).toBe(false);
  });
});

describe('doneTicketIds', () => {
  it('collects the identities of the done tickets only', () => {
    const done = ticket({ id: id(2) }).done();
    expect(doneTicketIds([ticket(), done, blocked])).toEqual(new Set([id(2)]));
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
    expect(isUnblocked(blocked, doneTicketIds([ticket().done()]))).toBe(false);
  });
});

describe('isUnclaimed', () => {
  it('holds for a ready ticket with no Runner', () => {
    expect(isUnclaimed(ticket())).toBe(true);
  });

  it('fails for a ticket that is being claimed', () => {
    expect(isUnclaimed(claiming)).toBe(false);
  });

  it('fails for a ticket assigned to a Runner', () => {
    expect(isUnclaimed(claimed)).toBe(false);
  });

  it('fails for a claimed ticket that names no Runner', () => {
    expect(isUnclaimed(ticket({ status: 'claimed' }))).toBe(false);
  });

  it('fails for a ticket that names a Runner without a claimed status', () => {
    expect(isUnclaimed(ticket({ claimedBy: runner }))).toBe(false);
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

describe('isEligible', () => {
  it('holds for an Unblocked, Unclaimed, Unattended ticket', () => {
    expect(isEligible(ticket(), none)).toBe(true);
  });

  it('holds for a ticket whose blockers are all done', () => {
    expect(isEligible(blocked, new Set([id(9)]))).toBe(true);
  });

  it('fails for a done ticket', () => {
    expect(isEligible(ticket().done(), none)).toBe(false);
    expect(isEligible(ticket({ status: 'done' }), none)).toBe(false);
  });

  it('does not depend on a stored blocked status', () => {
    expect(isEligible(ticket({ status: 'blocked', blockedBy: [id(9)] }), new Set([id(9)]))).toBe(true);
  });

  it.each([
    ['blocked', blocked],
    ['being claimed', claiming],
    ['claimed', claimed],
    ['attended', attended],
  ])('fails for a ticket that is %s', (_, candidate) => {
    expect(isEligible(candidate, none)).toBe(false);
  });

  it('fails for a ticket that misses every condition', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }).markClaiming(), none)).toBe(false);
  });

  it('fails for a ticket that misses two conditions', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }), none)).toBe(false);
    expect(isEligible(ticket({ blockedBy: [id(9)] }).claim({ by: runner }), none)).toBe(false);
  });

  it('does not depend on the stored ready-for-agent status', () => {
    expect(isEligible(ticket({ status: 'open' }), none)).toBe(true);
  });
});
