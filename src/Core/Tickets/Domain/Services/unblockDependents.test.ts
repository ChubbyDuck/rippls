import { describe, expect, it } from 'vitest';

import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';

import { unblockDependents } from './unblockDependents';

const id = (value: number) => formatTicketId('folder', String(value));

const blocked = (ticketId: number, blockedBy: number[]) =>
  Ticket.create({
    id: id(ticketId),
    title: 'Dependent',
    project: 'test',
    kind: 'implementation' as const,
    status: 'blocked' as const,
    blockedBy: blockedBy.map(id),
    blocks: [],
    body: '',
  });

describe('unblockDependents', () => {
  it('returns only the candidates that the completed id blocked', () => {
    const two = blocked(2, [1]);
    const three = blocked(3, [1, 4]);
    const five = blocked(5, [4]);

    const result = unblockDependents(id(1), [two, three, five]);

    expect(result.map((ticket) => ticket.id)).toEqual([id(2), id(3)]);
  });

  it('marks a candidate ready-for-agent when the completed id was its last blocker', () => {
    const [ready] = unblockDependents(id(1), [blocked(2, [1])]);

    expect(ready?.status).toBe('ready-for-agent');
    expect(ready?.blockedBy).toEqual([]);
  });

  it('keeps a candidate blocked when other blockers remain', () => {
    const [stillBlocked] = unblockDependents(id(1), [blocked(3, [1, 4])]);

    expect(stillBlocked?.status).toBe('blocked');
    expect(stillBlocked?.blockedBy).toEqual([id(4)]);
  });

  it('returns an empty list when no candidate is blocked by the completed id', () => {
    expect(unblockDependents(id(1), [blocked(5, [4])])).toEqual([]);
  });
});
