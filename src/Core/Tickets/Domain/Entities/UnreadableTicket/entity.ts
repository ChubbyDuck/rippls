import { Schema } from 'effect';

import { TicketId } from '../Ticket/properties/TicketId';

/**
 * Why a Source cannot read a ticket: a file whose name has no numeric prefix, front
 * matter that cannot be parsed, or a hint stated with an invalid value.
 */
export const UnreadableReason = Schema.Literals(['no numeric prefix', 'unparseable front matter', 'invalid hint']);

export type UnreadableReason = typeof UnreadableReason.Type;

/**
 * A ticket that its Source cannot read, so it is never taken. Its name tells a
 * human where it is: a path below the tickets folder, or the Title of an Issue.
 * It has an identity when the Source can tell one, as a file with a numeric prefix
 * can. The detail says what failed, for the front matter or a hint.
 */
export class UnreadableTicket extends Schema.Class<UnreadableTicket>('UnreadableTicket')({
  name: Schema.NonEmptyString,
  id: Schema.optionalKey(TicketId),
  reason: UnreadableReason,
  detail: Schema.optionalKey(Schema.String),
}) {
  /** The reason in words, with its detail. */
  get explanation(): string {
    return this.detail === undefined || this.detail === '' ? this.reason : `${this.reason}: ${this.detail}`;
  }
}

/** A detail on one line: the lines of a message, trimmed and joined with spaces. */
export const detailOf = (message: string): string =>
  message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
