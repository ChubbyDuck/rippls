import { expect, test } from 'vitest';

import { gateCircumstances, worktreeCircumstances } from './circumstances';

test('the briefing says the Ticket Worktree is ready and the ticket is in the prompt', () => {
  expect(worktreeCircumstances).toContain('Ticket Worktree');
  expect(worktreeCircumstances).toContain('Workspace dependencies are installed');
  expect(worktreeCircumstances).toContain('ticket text in this prompt');
  expect(worktreeCircumstances).toContain('pnx chubby');
});

test('the gate briefing starts from the existing package checks', () => {
  expect(gateCircumstances).toContain(worktreeCircumstances);
  expect(gateCircumstances).toContain("Start by running this app's typecheck, lint, and test");
});
