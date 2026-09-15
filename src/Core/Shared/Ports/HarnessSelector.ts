import { Context, type Effect } from 'effect';

import type { Harness } from '~/Core/Shared/Ports/Harness';

export class HarnessSelector extends Context.Service<
  HarnessSelector,
  {
    readonly select: Effect.Effect<Harness>;
  }
>()('HarnessSelector') {}
