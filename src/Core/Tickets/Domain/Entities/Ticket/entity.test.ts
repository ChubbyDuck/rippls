import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { RunnerId } from '~/Core/Shared/Domain/Properties/RunnerId';

import { Ticket } from './entity';
import { formatTicketId } from './properties/TicketId';

const runner = Schema.decodeSync(RunnerId)('runner');
const id = (value: number) => formatTicketId('folder', String(value));

const validImplementation = {
  id: id(14),
  title: 'Deliver one green ticket',
  project: '0003-sandboxed-local-ticket-loop.md',
  kind: 'implementation' as const,
  status: 'ready-for-agent' as const,
  blockedBy: [],
  blocks: [],
  body: '',
};

describe('Ticket', () => {
  it('creates an implementation ticket and fills implied hitl no', () => {
    const ticket = Ticket.create(validImplementation);

    expect(ticket.id).toBe(id(14));
    expect(ticket.label).toBe(`Ticket ${id(14)} -- implementation`);
    expect(ticket.kind).toBe('implementation');
    expect(ticket.hitl).toBe('no');
    expect(ticket.claimedBy).toBeUndefined();
  });

  it('creates a prototype ticket and fills implied hitl yes', () => {
    const ticket = Ticket.create({ ...validImplementation, kind: 'prototype' });

    expect(ticket.kind).toBe('prototype');
    expect(ticket.hitl).toBe('yes');
  });

  it('creates a task only when hitl is set explicitly', () => {
    const ticket = Ticket.create({
      ...validImplementation,
      kind: 'task',
      hitl: 'yes',
    });

    expect(ticket.kind).toBe('task');
    expect(ticket.hitl).toBe('yes');
  });

  it('accepts a runner claim', () => {
    const ticket = Ticket.create({
      ...validImplementation,
      status: 'claimed',
      claimedBy: runner,
    });

    expect(ticket.claimedBy).toBe('runner');
  });

  it('claims a ticket for a runner', () => {
    const ticket = Ticket.create(validImplementation);
    const claimed = ticket.claim({ by: runner });

    expect(claimed.status).toBe('claimed');
    expect(claimed.claimedBy).toBe('runner');
  });

  it('marks a claimed ticket as done', () => {
    const ticket = Ticket.create(validImplementation);
    const done = ticket.claim({ by: runner }).done();

    expect(done.status).toBe('done');
    expect(done.claimedBy).toBe('runner');
  });

  it('marks a ticket as claiming without a runner', () => {
    const ticket = Ticket.create(validImplementation);
    const claiming = ticket.markClaiming();

    expect(claiming.status).toBe('claiming');
    expect(claiming.claimedBy).toBeUndefined();
  });

  it('releases a claiming ticket back to ready-for-agent', () => {
    const ticket = Ticket.create(validImplementation);
    const released = ticket.markClaiming().release();

    expect(released.status).toBe('ready-for-agent');
    expect(released.claimedBy).toBeUndefined();
  });

  it('releases a claimed ticket and clears the runner', () => {
    const ticket = Ticket.create(validImplementation);
    const released = ticket.claim({ by: runner }).release();

    expect(released.status).toBe('ready-for-agent');
    expect(released.claimedBy).toBeUndefined();
  });

  it('keeps the body when marking claiming and releasing', () => {
    const ticket = Ticket.create({ ...validImplementation, body: 'Do the work.' });

    expect(ticket.markClaiming().body).toBe('Do the work.');
    expect(ticket.claim({ by: runner }).release().body).toBe('Do the work.');
  });

  it('rejects a non-positive id', () => {
    expect(() => Ticket.create({ ...validImplementation, id: 0 })).toThrow(Schema.SchemaError);
  });

  it('rejects an empty title', () => {
    expect(() => Ticket.create({ ...validImplementation, title: '' })).toThrow(Schema.SchemaError);
  });

  it('rejects a whitespace-only project', () => {
    expect(() => Ticket.create({ ...validImplementation, project: '   ' })).toThrow(Schema.SchemaError);
  });

  it('creates a ticket that omits project', () => {
    const { project: _project, ...withoutProject } = validImplementation;
    const ticket = Ticket.create(withoutProject);

    expect(ticket.project).toBeUndefined();
  });

  it('keeps an omitted project when claiming', () => {
    const { project: _project, ...withoutProject } = validImplementation;
    const claimed = Ticket.create(withoutProject).claim({ by: runner });

    expect(claimed.project).toBeUndefined();
  });

  it('ignores a provided hitl on implied kinds and uses the mapping', () => {
    const implementation = Ticket.create({ ...validImplementation, hitl: 'yes' });
    expect(implementation.hitl).toBe('no');

    const grilling = Ticket.create({ ...validImplementation, kind: 'grilling', hitl: 'no' });
    expect(grilling.hitl).toBe('yes');
  });

  it('rejects a task that omits hitl', () => {
    expect(() => Ticket.create({ ...validImplementation, kind: 'task' })).toThrow(Schema.SchemaError);
  });

  it('rejects a ticket that omits body', () => {
    const { body: _body, ...withoutBody } = validImplementation;
    expect(() => Ticket.create(withoutBody)).toThrow(Schema.SchemaError);
  });

  it('keeps the body when claiming and completing', () => {
    const ticket = Ticket.create({ ...validImplementation, body: 'Do the work.' });
    expect(ticket.body).toBe('Do the work.');
    expect(ticket.claim({ by: runner }).body).toBe('Do the work.');
    expect(ticket.claim({ by: runner }).done().body).toBe('Do the work.');
  });

  it('escalates a ticket to a human task', () => {
    const ticket = Ticket.create({ ...validImplementation, body: 'Do the work.' }).claim({ by: runner });
    const escalated = ticket.escalate();

    expect(escalated.kind).toBe('task');
    expect(escalated.hitl).toBe('yes');
    expect(escalated.status).toBe('ready-for-agent');
    expect(escalated.claimedBy).toBeUndefined();
    expect(escalated.body).toBe('Do the work.');
  });

  it('reports whether a ticket is blocked by a given id', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'blocked', blockedBy: [id(1), id(2)] });

    expect(ticket.isBlockedBy(id(1))).toBe(true);
    expect(ticket.isBlockedBy(id(3))).toBe(false);
  });

  it('becomes ready-for-agent when the last blocker is removed', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'blocked', blockedBy: [id(1)] });
    const unblocked = ticket.unblockedBy(id(1));

    expect(unblocked.status).toBe('ready-for-agent');
    expect(unblocked.blockedBy).toEqual([]);
  });

  it('stays blocked when other blockers remain', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'blocked', blockedBy: [id(1), id(2)] });
    const unblocked = ticket.unblockedBy(id(1));

    expect(unblocked.status).toBe('blocked');
    expect(unblocked.blockedBy).toEqual([id(2)]);
  });

  it('leaves the blocker list unchanged when the id is not a blocker', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'blocked', blockedBy: [id(2)] });
    const unblocked = ticket.unblockedBy(id(1));

    expect(unblocked.status).toBe('blocked');
    expect(unblocked.blockedBy).toEqual([id(2)]);
  });
});
