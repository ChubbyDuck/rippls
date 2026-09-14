import { Schema } from 'effect';

import type { HarnessId } from './HarnessId';

export const RunnerId = Schema.NonEmptyString.pipe(Schema.brand('RunnerId'));

export type RunnerId = typeof RunnerId.Type;

export const runnerIdFrom = (harnessId: HarnessId, unique: string): RunnerId =>
  Schema.decodeSync(RunnerId)(`${harnessId}:${unique}`);

