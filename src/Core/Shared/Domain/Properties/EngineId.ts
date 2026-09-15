import { Schema } from 'effect';

export const EngineId = Schema.NonEmptyString.pipe(Schema.brand('EngineId'));

export type EngineId = typeof EngineId.Type;
