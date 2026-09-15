import { Schema } from 'effect';

import type { EngineId } from './EngineId';

export const RunnerId = Schema.NonEmptyString.pipe(Schema.brand('RunnerId'));

export type RunnerId = typeof RunnerId.Type;

export const runnerIdFrom = (engineId: EngineId, unique: string): RunnerId =>
  Schema.decodeSync(RunnerId)(`${engineId}:${unique}`);

