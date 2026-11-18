import type { Hitl } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { formatTicketId } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketId';
import { Hitl as HitlSchema } from '~/Core/Tickets/Domain/Entities/Ticket/properties/Hitl';
import { hitlImpliedBy, TicketKind } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import type { TicketKind as TicketKindValue } from '~/Core/Tickets/Domain/Entities/Ticket/properties/TicketKind';
import { type Fixture, FixtureStatus } from '~/Core/Tickets/Ports/FixtureWriter';

const DEFAULT_PROJECT = 'generated';

export interface GenerateOptions {
  readonly count: number;
  readonly kinds: ReadonlyArray<TicketKindValue>;
  readonly statuses: ReadonlyArray<FixtureStatus>;
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
  readonly statuses: ReadonlyArray<FixtureStatus>;
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
    const derived = hitlImpliedBy(kind);
    if (derived === undefined) {
      return hitls.map((hitl) => ({ kind, hitl }));
    }
    return hitls.includes(derived) ? [{ kind, hitl: derived }] : [];
  });

export const resolvePlan = (options: GenerateOptions): ResolvedPlan => ({
  kindHitls: validKindHitls(orAll(options.kinds, TicketKind.literals), orAll(options.hitls, HitlSchema.literals)),
  statuses: orAll(options.statuses, FixtureStatus.literals),
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

const toFixture = (id: number, kindHitl: KindHitl, status: FixtureStatus, project: string, links: TicketLinks): Fixture => ({
  id: formatTicketId('folder', String(id)),
  title: `Generated ticket ${id}`,
  project,
  status,
  kind: kindHitl.kind,
  hitl: kindHitl.hitl,
  blockedBy: links.blockedBy.map((native) => formatTicketId('folder', String(native))),
  blocks: links.blocks.map((native) => formatTicketId('folder', String(native))),
  body: fakeBody(id),
});

// Cycle each attribute at its own rate, so every attribute value appears about
// equally often even when the count is smaller than the full combination space.
export const planTickets = (count: number, plan: ResolvedPlan, chain = false): ReadonlyArray<Fixture> =>
  plan.kindHitls.length === 0
    ? []
    : Array.from({ length: count }, (_unused, index) => {
        const id = index + 1;
        return toFixture(
          id,
          plan.kindHitls[index % plan.kindHitls.length]!,
          plan.statuses[index % plan.statuses.length]!,
          plan.projects[index % plan.projects.length]!,
          chain ? consecutiveLinks(id, count) : noLinks
        );
      });
