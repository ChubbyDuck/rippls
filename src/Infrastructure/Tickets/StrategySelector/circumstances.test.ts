import { expect, test } from 'vitest';

import { verdictInstruction, worktreeCircumstances } from './circumstances';

test('the briefing says the Agent is in the Workspace and the ticket is in the prompt, and claims no install', () => {
  expect(worktreeCircumstances).toContain("this ticket's Workspace");
  expect(worktreeCircumstances).toContain('ticket text is in this prompt');
  expect(worktreeCircumstances).not.toContain('Ticket Worktree');
  expect(worktreeCircumstances).not.toContain('installed');
});

test('the briefing names no script runner and does not forbid looking for a ticket file', () => {
  expect(worktreeCircumstances).not.toContain('pnx');
  expect(worktreeCircumstances).not.toContain('ticket file');
});

test('the verdict instruction names the pass and the fail signal', () => {
  expect(verdictInstruction).toContain('"VERDICT:PASS"');
  expect(verdictInstruction).toContain('"VERDICT:FAIL"');
});
