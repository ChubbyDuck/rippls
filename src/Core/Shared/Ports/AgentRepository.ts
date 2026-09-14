import { Context, type Effect } from 'effect';

import type { Agent } from '~/Core/Shared/Ports/Agent';

export class AgentRepository extends Context.Service<
  AgentRepository,
  {
    readonly getOne: Effect.Effect<Agent>;
  }
>()('AgentRepository') {}
