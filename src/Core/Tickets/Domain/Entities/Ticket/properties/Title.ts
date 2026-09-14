import { Schema } from 'effect';

export const Title = Schema.NonEmptyString.check(Schema.isTrimmed()).pipe(Schema.brand('Title'));

export type Title = typeof Title.Type;
