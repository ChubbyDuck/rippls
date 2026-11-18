// Facts Ticket Processing already arranged. The Agent should not rediscover them.
export const worktreeCircumstances =
  "You are already in this ticket's Ticket Worktree. Workspace dependencies are installed.\n" +
  'The ticket text is in this prompt.';

// A verdict step ends with one of these. The Harness matches the emitted substring
// and returns it as the completion signal.
export const VERDICT_PASS = 'VERDICT:PASS';
export const VERDICT_FAIL = 'VERDICT:FAIL';

export const verdictInstruction =
  `When you finish, print exactly "${VERDICT_PASS}" if the work passes this step. ` +
  `Otherwise print exactly "${VERDICT_FAIL}".`;
