import { Config, Effect, Layer, Option } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { parseTicketId, type TicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import type { TicketEvent } from '~/Core/Tickets/Domain/Events/TicketEvent';
import { TicketEventNotReported } from '~/Core/Tickets/Domain/Exceptions/TicketEventNotReported';
import { TicketNotFound } from '~/Core/Tickets/Domain/Exceptions/TicketNotFound';
import { TicketNotSaved } from '~/Core/Tickets/Domain/Exceptions/TicketNotSaved';
import type { TicketQuery } from '~/Core/Tickets/Domain/Queries/TicketQuery';
import { LinearApi, type LinearIssue, type LinearMetadata } from '~/Core/Tickets/Ports/LinearApi';
import { TicketSource } from '~/Core/Tickets/Ports/TicketSource';

import {
  claimWrites,
  issueToTicket,
  type LinearWrite,
  releaseWrites,
  ticketToWrites,
} from '~/Infrastructure/Tickets/LinearApi/codec';

// A read by identity also finds a started Issue, so the Engine can complete the
// Issue it claimed. A started Issue is already claimed on Linear, so the read of
// every ticket in scope does not offer it for processing.
const READABLE_STATE_TYPES: ReadonlySet<string> = new Set(['unstarted', 'started']);
const OFFERED_STATE_TYPES: ReadonlySet<string> = new Set(['unstarted']);

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
    if (query.project !== undefined && ticket.project !== query.project) {
      return false;
    }
    return true;
  };

const toTickets = (
  issues: readonly LinearIssue[],
  metadata: LinearMetadata,
  query: TicketQuery,
  stateTypes: ReadonlySet<string>
): readonly Ticket[] => {
  const ranked = issues.flatMap((issue) => {
    if (!stateTypes.has(issue.state.type)) {
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

export const TicketSourceLinearLive = Layer.effect(
  TicketSource,
  Effect.gen(function* () {
    const api = yield* LinearApi;
    const teamId = yield* Config.nonEmptyString('teamId');

    const pull = (query: TicketQuery) =>
      Effect.gen(function* () {
        const metadata = yield* api.metadata(teamId);
        if (query.id !== undefined) {
          const issue = yield* api.issue(parseTicketId(query.id).native);
          return toTickets([issue], metadata, query, READABLE_STATE_TYPES);
        }
        const issues = yield* api.issues(teamId);
        return toTickets(issues, metadata, query, OFFERED_STATE_TYPES);
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

    const applyNeeded = (issueId: string, writes: readonly LinearWrite[]) =>
      writes.length === 0
        ? Effect.void
        : api.issue(issueId).pipe(
            Effect.map((current) => writes.filter((write) => !isNoOp(write, current))),
            Effect.flatMap((needed) => Effect.forEach(needed, applyWrite, { discard: true }))
          );

    const save = (ticket: Ticket): Effect.Effect<void, TicketNotSaved> =>
      api.metadata(teamId).pipe(
        Effect.flatMap((metadata) => applyNeeded(parseTicketId(ticket.id).native, ticketToWrites(ticket, metadata))),
        Effect.mapError(() => new TicketNotSaved())
      );

    // A Claim on Linear is confirmed by reading the Issue back: another user or
    // workspace may have taken it in between, and then the report fails.
    const confirmClaim = (issueId: string, metadata: LinearMetadata) =>
      api.issue(issueId).pipe(
        Effect.filterOrFail(
          (confirmed) => confirmed.assigneeId === metadata.viewer.id && confirmed.state.type === 'started',
          () => 'The Issue is not assigned to the API-key user in a started state'
        )
      );

    const report = (ticket: TicketId, event: TicketEvent): Effect.Effect<void, TicketEventNotReported> =>
      Effect.gen(function* () {
        const metadata = yield* api.metadata(teamId);
        const issueId = parseTicketId(ticket).native;
        if (event === 'claimed') {
          yield* applyNeeded(issueId, claimWrites(issueId, metadata));
          yield* confirmClaim(issueId, metadata);
          return;
        }
        yield* applyNeeded(issueId, releaseWrites(issueId, metadata));
      }).pipe(Effect.mapError(() => new TicketEventNotReported({ ticketId: ticket, event })));

    const saveMany = (tickets: readonly Ticket[]): Effect.Effect<void, TicketNotSaved> =>
      Effect.forEach(tickets, save, { discard: true });

    return { getOneBy, getManyBy, save, saveMany, report };
  })
);
