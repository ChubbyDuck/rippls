import { Schema } from 'effect';

export const HarnessId = Schema.NonEmptyString.pipe(Schema.brand('HarnessId'));

export type HarnessId = typeof HarnessId.Type;
