// Facts Ticket Processing already arranged, in either Workspace. The Agent should
// not rediscover them. In place, nothing is installed, so the briefing claims no
// dependency install.
export const worktreeCircumstances =
  "You are already in this ticket's Workspace, the directory where its work happens.\n" +
  'The ticket text is in this prompt.';

// A verdict step ends with one of these. The Harness matches the emitted substring
// and returns it as the completion signal.
export const VERDICT_PASS = 'VERDICT:PASS';
export const VERDICT_FAIL = 'VERDICT:FAIL';

export const verdictInstruction =
  `When you finish, print exactly "${VERDICT_PASS}" if the work passes this step. ` +
  `Otherwise print exactly "${VERDICT_FAIL}".`;
