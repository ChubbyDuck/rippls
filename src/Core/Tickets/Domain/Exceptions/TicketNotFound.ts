import { Data } from 'effect';

export class TicketNotFound extends Data.TaggedError('TicketNotFound') {}
