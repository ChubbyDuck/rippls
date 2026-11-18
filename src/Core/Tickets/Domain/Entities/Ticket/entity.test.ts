import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Ticket } from './entity';
import { formatTicketId } from './properties/TicketId';

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

  it('ignores a claim field that an earlier Engine wrote', () => {
    const ticket = Ticket.create({ ...validImplementation, claimedBy: 'runner' });

    expect('claimedBy' in ticket).toBe(false);
  });

  it('rejects a claim status, since the Claim lives in the Ledger', () => {
    expect(() => Ticket.create({ ...validImplementation, status: 'claimed' })).toThrow(Schema.SchemaError);
    expect(() => Ticket.create({ ...validImplementation, status: 'claiming' })).toThrow(Schema.SchemaError);
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

  it('reports whether a ticket is blocked by a given id', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'blocked', blockedBy: [id(1), id(2)] });

    expect(ticket.isBlockedBy(id(1))).toBe(true);
    expect(ticket.isBlockedBy(id(3))).toBe(false);
  });
});
