import { expect, test } from 'vitest';

import { verdictInstruction, worktreeCircumstances } from './circumstances';

test('the briefing says the Ticket Worktree is ready and the ticket is in the prompt', () => {
  expect(worktreeCircumstances).toContain('Ticket Worktree');
  expect(worktreeCircumstances).toContain('Workspace dependencies are installed');
  expect(worktreeCircumstances).toContain('ticket text is in this prompt');
});

test('the briefing names no script runner and does not forbid looking for a ticket file', () => {
  expect(worktreeCircumstances).not.toContain('pnx');
  expect(worktreeCircumstances).not.toContain('ticket file');
});

test('the verdict instruction names the pass and the fail signal', () => {
  expect(verdictInstruction).toContain('"VERDICT:PASS"');
  expect(verdictInstruction).toContain('"VERDICT:FAIL"');
});
