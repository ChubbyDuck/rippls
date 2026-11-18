import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';

// What each placeholder of a prompt template, written `{{name}}`, stands for.
const placeholderValues: Readonly<Record<string, (ticket: Ticket) => string>> = {
  id: (ticket) => ticket.id,
  title: (ticket) => ticket.title,
  body: (ticket) => ticket.body,
  project: (ticket) => ticket.project ?? '',
};

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * The prompt for a ticket from a template that refers to it with `{{id}}`,
 * `{{title}}`, `{{body}}`, and `{{project}}`. `{{project}}` is empty for a ticket
 * without a Project. Any other placeholder stays as written.
 */
export const renderPrompt = (template: string, ticket: Ticket): string =>
  template.replace(PLACEHOLDER, (placeholder, name: string) =>
    Object.hasOwn(placeholderValues, name) ? placeholderValues[name]!(ticket) : placeholder
  );
