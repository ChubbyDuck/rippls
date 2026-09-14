import { Config, Effect, Layer, Option } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { parseTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { LinearApi, type LinearIssue, type LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';
import { TicketRepository } from '~/Core/Tickets/Ports/TicketRepository';

import { issueToTicket, type LinearWrite, ticketToWrites } from '~/Infrastructure/Tickets/LinearApi/codec';

const READABLE_STATE_TYPES = new Set(['unstarted', 'started']);

const isNoOp = (write: LinearWrite, issue: LinearIssue): boolean => {
  switch (write.op) {
    case 'setAssignee':
      return issue.assigneeId === write.assigneeId;
    case 'setState':
      return issue.state.id === write.stateId;
    case 'setLabels': {
      const present = new Set(issue.labels.map((label) => label.id));
      return (
        write.addedLabelIds.every((id) => present.has(id)) && write.removedLabelIds.every((id) => !present.has(id))
      );
    }
  }
};

const matchesQuery =
  (query: TicketQuery) =>
  (ticket: Ticket): boolean => {
    if (query.id !== undefined && ticket.id !== query.id) {
      return false;
    }
    if (query.blockedBy !== undefined && !ticket.isBlockedBy(query.blockedBy)) {
      return false;
    }
    if (query.unblocked === true && ticket.blockedBy.length !== 0) {
      return false;
    }
    if (
      query.unclaimed === true &&
      (ticket.claimedBy !== undefined || ticket.status === 'claiming' || ticket.status === 'claimed')
    ) {
      return false;
    }
    if (query.claimed === true && ticket.status !== 'claiming' && ticket.status !== 'claimed') {
      return false;
    }
    if (query.afk === true && ticket.hitl !== 'no') {
      return false;
    }
    if (query.project !== undefined && ticket.project !== query.project) {
      return false;
    }
    return true;
  };

const toTickets = (
  issues: readonly LinearIssue[],
  metadata: LinearMetadata,
  query: TicketQuery
): readonly Ticket[] => {
  const ranked = issues.flatMap((issue) => {
    if (!READABLE_STATE_TYPES.has(issue.state.type)) {
      return [];
    }
    return Option.match(issueToTicket(issue, metadata), {
      onNone: () => [],
      onSome: (ticket) => (matchesQuery(query)(ticket) ? [{ ticket, createdAt: issue.createdAt }] : []),
    });
  });
  const descending = query.sort === 'DESC';
  const ordered = ranked.toSorted((left, right) => {
    const cmp = left.createdAt.localeCompare(right.createdAt);
    return descending ? -cmp : cmp;
  });
  const tickets = ordered.map((entry) => entry.ticket);
  return query.limit === undefined ? tickets : tickets.slice(0, query.limit);
};

export const TicketRepositoryLinearLive = Layer.effect(
  TicketRepository,
  Effect.gen(function* () {
    const api = yield* LinearApi;
    const teamId = yield* Config.nonEmptyString('teamId');

    const pull = (query: TicketQuery) =>
      Effect.gen(function* () {
        const metadata = yield* api.metadata(teamId);
        if (query.id !== undefined) {
          const issue = yield* api.issue(parseTicketId(query.id).native);
          return toTickets([issue], metadata, query);
        }
        const issues = yield* api.issues(teamId);
        return toTickets(issues, metadata, query);
      });

    const getOneBy = (query: TicketQuery): Effect.Effect<Ticket, TicketNotFound> =>
      pull(query).pipe(
        Effect.map((tickets) => tickets[0]),
        Effect.filterOrFail((ticket): ticket is Ticket => ticket !== undefined, () => new TicketNotFound()),
        Effect.catchCause(() => Effect.fail(new TicketNotFound()))
      );

    const getManyBy = (query: TicketQuery): Effect.Effect<readonly Ticket[]> =>
      pull(query).pipe(Effect.catchCause(() => Effect.succeed<readonly Ticket[]>([])));

    const applyWrite = (write: LinearWrite) => {
      switch (write.op) {
        case 'setAssignee':
          return api.setAssignee(write.issueId, write.assigneeId);
        case 'setState':
          return api.setState(write.issueId, write.stateId);
        case 'setLabels':
          return api.setLabels(write.issueId, write.addedLabelIds, write.removedLabelIds);
      }
    };

    const save = (ticket: Ticket): Effect.Effect<void, TicketNotSaved> =>
      Effect.gen(function* () {
        const metadata = yield* api.metadata(teamId);
        const issueId = parseTicketId(ticket.id).native;
        const writes = ticketToWrites(ticket, metadata);
        if (writes.length === 0) {
          return;
        }
        const current = yield* api.issue(issueId);
        const needed = writes.filter((write) => !isNoOp(write, current));
        yield* Effect.forEach(needed, applyWrite, { discard: true });
        if (ticket.status !== 'claiming') {
          return;
        }
        const confirmed = yield* api.issue(issueId);
        if (confirmed.assigneeId !== metadata.viewer.id || confirmed.state.type !== 'started') {
          return yield* new TicketNotSaved();
        }
      }).pipe(Effect.mapError(() => new TicketNotSaved()));

    const saveMany = (tickets: readonly Ticket[]): Effect.Effect<void, TicketNotSaved> =>
      Effect.forEach(tickets, save, { discard: true });

    return { getOneBy, getManyBy, save, saveMany };
  })
);
