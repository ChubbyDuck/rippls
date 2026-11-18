import { Schema } from 'effect';

import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

// The fields of a ticket that a prompt template can refer to, each as `{{name}}`.
const placeholderNames = ['id', 'title', 'body', 'project'] as const;

type PlaceholderName = (typeof placeholderNames)[number];

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

const isPlaceholderName = (name: string): name is PlaceholderName =>
  (placeholderNames as readonly string[]).includes(name);

const unknownPlaceholders = (template: string): string[] =>
  [...template.matchAll(PLACEHOLDER)].map(([, name]) => name ?? '').filter((name) => !isPlaceholderName(name));

/**
 * A prompt that refers to the ticket with `{{id}}`, `{{title}}`, `{{body}}`, and
 * `{{project}}`. Any other placeholder is rejected, so a misspelt one does not
 * reach an Agent.
 */
export const PromptTemplate = Schema.NonEmptyString.check(
  Schema.makeFilter((template: string) => {
    const unknown = unknownPlaceholders(template);
    return unknown.length === 0
      ? undefined
      : `Unknown placeholder ${unknown.map((name) => `{{${name}}}`).join(', ')}; ` +
          `a prompt template can refer to ${placeholderNames.map((name) => `{{${name}}}`).join(', ')}`;
  })
);

const valueOf = (ticket: Ticket, name: PlaceholderName): string => {
  switch (name) {
    case 'id':
      return ticket.id;
    case 'title':
      return ticket.title;
    case 'body':
      return ticket.body;
    case 'project':
      return ticket.project ?? '';
  }
};

/** The prompt for a ticket. `{{project}}` is empty for a ticket without a Project. */
export const renderPrompt = (template: string, ticket: Ticket): string =>
  template.replace(PLACEHOLDER, (placeholder, name: string) =>
    isPlaceholderName(name) ? valueOf(ticket, name) : placeholder
  );
