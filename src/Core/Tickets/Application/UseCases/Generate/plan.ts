import { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import type { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { Hitl as HitlSchema } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { impliedHitlByKind, TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { TicketKind as TicketKindValue } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { TicketStatus } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';
import type { TicketStatus as TicketStatusValue } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketStatus';

const DEFAULT_PROJECT = 'generated';

export interface GenerateOptions {
  readonly count: number;
  readonly kinds: ReadonlyArray<TicketKindValue>;
  readonly statuses: ReadonlyArray<TicketStatusValue>;
  readonly hitls: ReadonlyArray<Hitl>;
  readonly projects: ReadonlyArray<string>;
  readonly chain: boolean;
}

interface KindHitl {
  readonly kind: TicketKindValue;
  readonly hitl: Hitl;
}

export interface ResolvedPlan {
  readonly kindHitls: ReadonlyArray<KindHitl>;
  readonly statuses: ReadonlyArray<TicketStatusValue>;
  readonly projects: ReadonlyArray<string>;
}

const orAll = <A>(subset: ReadonlyArray<A>, all: ReadonlyArray<A>): ReadonlyArray<A> =>
  subset.length === 0 ? all : subset;

// The application rules fix the hitl of every kind but 'task'. So an implied
// kind produces one pair, and only when the requested hitl subset allows it.
const validKindHitls = (
  kinds: ReadonlyArray<TicketKindValue>,
  hitls: ReadonlyArray<Hitl>
): ReadonlyArray<KindHitl> =>
  kinds.flatMap((kind): ReadonlyArray<KindHitl> => {
    if (kind === 'task') {
      return hitls.map((hitl) => ({ kind, hitl }));
    }
    const derived = impliedHitlByKind[kind];
    return hitls.includes(derived) ? [{ kind, hitl: derived }] : [];
  });

export const resolvePlan = (options: GenerateOptions): ResolvedPlan => ({
  kindHitls: validKindHitls(orAll(options.kinds, TicketKind.literals), orAll(options.hitls, HitlSchema.literals)),
  statuses: orAll(options.statuses, TicketStatus.literals),
  projects: orAll(options.projects, [DEFAULT_PROJECT]),
});

const PROMPTS = ['Reply with hello.', 'What is 2 + 2?', 'Name one color.', 'Say yes.'];

const fakeBody = (id: number): string => PROMPTS[(id - 1) % PROMPTS.length]!;

interface TicketLinks {
  readonly blockedBy: ReadonlyArray<number>;
  readonly blocks: ReadonlyArray<number>;
}

const consecutiveLinks = (id: number, count: number): TicketLinks => ({
  blockedBy: id > 1 ? [id - 1] : [],
  blocks: id < count ? [id + 1] : [],
});

const noLinks: TicketLinks = { blockedBy: [], blocks: [] };

const toTicket = (id: number, kindHitl: KindHitl, status: TicketStatusValue, project: string, links: TicketLinks): Ticket =>
  Ticket.create({
    id: formatTicketId('folder', String(id)),
    title: `Generated ticket ${id}`,
    project,
    status,
    kind: kindHitl.kind,
    blockedBy: links.blockedBy.map((native) => formatTicketId('folder', String(native))),
    blocks: links.blocks.map((native) => formatTicketId('folder', String(native))),
    body: fakeBody(id),
    ...(kindHitl.kind === 'task' ? { hitl: kindHitl.hitl } : {}),
  });

// Cycle each attribute at its own rate, so every attribute value appears about
// equally often even when the count is smaller than the full combination space.
export const planTickets = (count: number, plan: ResolvedPlan, chain = false): ReadonlyArray<Ticket> =>
  plan.kindHitls.length === 0
    ? []
    : Array.from({ length: count }, (_unused, index) => {
        const id = index + 1;
        return toTicket(
          id,
          plan.kindHitls[index % plan.kindHitls.length]!,
          plan.statuses[index % plan.statuses.length]!,
          plan.projects[index % plan.projects.length]!,
          chain ? consecutiveLinks(id, count) : noLinks
        );
      });
