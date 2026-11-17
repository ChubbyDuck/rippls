import { describe, expect, it } from 'vitest';

import type { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';
import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { isEligible, isUnattended, isUnblocked, isUnclaimed } from './eligibility';

const id = (value: number) => formatTicketId('folder', String(value));
const runner = 'runner-1' as RunnerId;

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

describe('isUnblocked', () => {
  it('holds for a ticket with no blockers', () => {
    expect(isUnblocked(ticket())).toBe(true);
  });

  it('fails for a ticket with a remaining blocker', () => {
    expect(isUnblocked(blocked)).toBe(false);
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
    expect(isEligible(ticket())).toBe(true);
  });

  it.each([
    ['blocked', blocked],
    ['being claimed', claiming],
    ['claimed', claimed],
    ['attended', attended],
  ])('fails for a ticket that is %s', (_, candidate) => {
    expect(isEligible(candidate)).toBe(false);
  });

  it('fails for a ticket that misses every condition', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }).markClaiming())).toBe(false);
  });

  it('fails for a ticket that misses two conditions', () => {
    expect(isEligible(ticket({ hitl: 'yes', blockedBy: [id(9)] }))).toBe(false);
    expect(isEligible(ticket({ blockedBy: [id(9)] }).claim({ by: runner }))).toBe(false);
  });

  it('does not depend on the stored ready-for-agent status', () => {
    expect(isEligible(ticket({ status: 'open' }))).toBe(true);
  });
});
