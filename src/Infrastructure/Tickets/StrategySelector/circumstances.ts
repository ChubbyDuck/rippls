// Facts Ticket Processing already arranged. The Agent should not rediscover them.
export const worktreeCircumstances =
  'You are already in this ticket\'s Ticket Worktree. Workspace dependencies are installed.\n' +
  'Work from the ticket text in this prompt. Run package scripts with `pnx chubby <alias> <script>`.\n' +
  'Do not search for a ticket file, install packages, or inspect other worktrees for node_modules.';

export const gateCircumstances =
  `${worktreeCircumstances}\n` +
  "Implement already ran in this tree. Start by running this app's typecheck, lint, and test. Do not spend time locating how the repo is checked.";
