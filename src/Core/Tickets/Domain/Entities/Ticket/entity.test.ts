import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { Ticket } from './entity';
import { formatTicketId } from './properties/TicketId';

const id = (value: number) => formatTicketId('folder', String(value));

const identityAndText = {
  id: id(14),
  title: 'Deliver one green ticket',
  body: '',
};

const validImplementation = {
  ...identityAndText,
  project: '0003-sandboxed-local-ticket-loop.md',
  kind: 'implementation' as const,
};

const readyFolder = { kind: 'implementation' as const, hitl: 'no' as const };

describe('Ticket', () => {
  it('needs only an identity, a Title, and a body', () => {
    const ticket = Ticket.create(identityAndText);

    expect(ticket.id).toBe(id(14));
    expect(ticket.project).toBeUndefined();
    expect(ticket.blockedBy).toEqual([]);
    expect(ticket.doneInSource).toBe(false);
  });

  it('takes the default Ticket Kind when it states none', () => {
    expect(Ticket.create(identityAndText).kind).toBe('implementation');
    expect(Ticket.create(identityAndText, { kind: 'research', hitl: 'yes' }).kind).toBe('research');
  });

  it('keeps a stated Ticket Kind', () => {
    expect(Ticket.create({ ...identityAndText, kind: 'grilling' }, readyFolder).kind).toBe('grilling');
  });

  it('creates an implementation ticket and fills implied hitl no', () => {
    const ticket = Ticket.create(validImplementation);

    expect(ticket.label).toBe(`Ticket ${id(14)} -- implementation`);
    expect(ticket.hitl).toBe('no');
  });

  it('creates a prototype ticket and fills implied hitl yes', () => {
    expect(Ticket.create({ ...validImplementation, kind: 'prototype' }).hitl).toBe('yes');
  });

  it('ignores a claim field that an earlier Engine wrote', () => {
    const ticket = Ticket.create({ ...validImplementation, claimedBy: 'runner' });

    expect('claimedBy' in ticket).toBe(false);
  });

  it('stores no status and no blocks list', () => {
    const ticket = Ticket.create({ ...validImplementation, status: 'claimed', blocks: [id(2)] });

    expect('status' in ticket).toBe(false);
    expect('blocks' in ticket).toBe(false);
  });

  it('rejects an invalid value for a known hint', () => {
    expect(() => Ticket.create({ ...validImplementation, kind: 'chore' })).toThrow(Schema.SchemaError);
    expect(() => Ticket.create({ ...validImplementation, hitl: 'maybe' })).toThrow(Schema.SchemaError);
    expect(() => Ticket.create({ ...validImplementation, project: '   ' })).toThrow(Schema.SchemaError);
  });

  it('rejects a non-positive id', () => {
    expect(() => Ticket.create({ ...validImplementation, id: 0 })).toThrow(Schema.SchemaError);
  });

  it('rejects an empty title', () => {
    expect(() => Ticket.create({ ...validImplementation, title: '' })).toThrow(Schema.SchemaError);
  });

  it('rejects a ticket that omits body', () => {
    const { body: _body, ...withoutBody } = validImplementation;
    expect(() => Ticket.create(withoutBody)).toThrow(Schema.SchemaError);
  });

  it('reports whether a ticket is blocked by a given id', () => {
    const ticket = Ticket.create({ ...validImplementation, blockedBy: [id(1), id(2)] });

    expect(ticket.isBlockedBy(id(1))).toBe(true);
    expect(ticket.isBlockedBy(id(3))).toBe(false);
  });
});

describe('the HITL of a Ticket', () => {
  it('is a stated HITL first, over a Marker and a stated Ticket Kind', () => {
    expect(Ticket.create({ ...identityAndText, hitl: 'yes', marker: 'ready-for-agent', kind: 'research' }).hitl).toBe(
      'yes'
    );
    expect(Ticket.create({ ...identityAndText, hitl: 'no', marker: 'ready-for-human', kind: 'grilling' }).hitl).toBe(
      'no'
    );
  });

  it('is the HITL of the Marker next: ready-for-agent is no, ready-for-human is yes', () => {
    expect(Ticket.create({ ...identityAndText, marker: 'ready-for-agent' }).hitl).toBe('no');
    expect(Ticket.create({ ...identityAndText, marker: 'ready-for-human' }).hitl).toBe('yes');
  });

  it('is the HITL of the Marker over the HITL a stated Ticket Kind implies', () => {
    expect(Ticket.create({ ...identityAndText, marker: 'ready-for-human', kind: 'implementation' }).hitl).toBe('yes');
    expect(Ticket.create({ ...identityAndText, marker: 'ready-for-agent', kind: 'prototype' }).hitl).toBe('no');
  });

  it('is the HITL a stated Ticket Kind implies next', () => {
    expect(Ticket.create({ ...identityAndText, kind: 'implementation' }).hitl).toBe('no');
    expect(Ticket.create({ ...identityAndText, kind: 'research' }).hitl).toBe('no');
    expect(Ticket.create({ ...identityAndText, kind: 'prototype' }, readyFolder).hitl).toBe('yes');
    expect(Ticket.create({ ...identityAndText, kind: 'grilling' }, readyFolder).hitl).toBe('yes');
  });

  it('is the fallback for a stated task, which implies nothing', () => {
    expect(Ticket.create({ ...identityAndText, kind: 'task' }).hitl).toBe('yes');
    expect(Ticket.create({ ...identityAndText, kind: 'task' }, readyFolder).hitl).toBe('no');
  });

  it('is yes when the ticket states nothing, though the default Ticket Kind implies no', () => {
    const ticket = Ticket.create(identityAndText);

    expect(ticket.kind).toBe('implementation');
    expect(ticket.hitl).toBe('yes');
  });

  it('is the configured fallback when the ticket states nothing', () => {
    expect(Ticket.create(identityAndText, readyFolder).hitl).toBe('no');
  });
});
