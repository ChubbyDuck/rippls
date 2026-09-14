import { Schema } from 'effect';

export const Project = Schema.NonEmptyString.check(Schema.isTrimmed()).pipe(Schema.brand('Project'));

export type Project = typeof Project.Type;
