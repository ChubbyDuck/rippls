import { Console, Duration, Effect } from 'effect';

import { type CheckConfig, checkCommandOf } from '~/Core/Shared/Domain/EngineConfig';
import type { Harness } from '~/Core/Shared/Ports/Harness';
import type { Ticket } from '~/Core/Tickets/Domain/Entities/Ticket/entity';
import { type CommandRun, type Worktree, WorktreeManager } from '~/Core/Tickets/Ports/WorktreeManager';

// The fix prompt carries this many lines from the end of the command output.
const OUTPUT_LINES = 200;

const lastLines = (output: string, count: number): string => output.trimEnd().split('\n').slice(-count).join('\n');

const verdictOf = (run: CommandRun, timeLimit: Duration.Duration): string =>
  run._tag === 'Exited'
    ? `It exited with code ${run.exitCode}.`
    : `Its time limit of ${Duration.format(timeLimit)} ended it.`;

const fixPromptOf = (check: CheckConfig, command: string, run: CommandRun): string =>
  `${check.fixPrompt}\n\n` +
  `The check command is \`${command}\`. ${verdictOf(run, check.timeLimit)}\n` +
  `The last ${OUTPUT_LINES} lines of its output:\n\n` +
  '```text\n' +
  `${lastLines(run.output, OUTPUT_LINES)}\n` +
  '```';

// Runs the check command of the ticket in its Ticket Worktree. Exit code zero
// passes. A non-zero exit code or the time limit fails the check: the fix prompt
// goes to the Harness with the end of the output, and the command runs again, up
// to the configured number of fix attempts. With no command the check is skipped.
// The value tells whether the work passed.
export const checkTicketWorktree = Effect.fn('ticket.check')(function* (
  ticket: Ticket,
  worktree: Worktree,
  harness: Harness,
  check: CheckConfig
) {
  const command = checkCommandOf(check, ticket.project);
  if (command === undefined) {
    yield* Console.log(`${ticket.label} has no check command configured, so the check is skipped`);
    return true;
  }
  const worktrees = yield* WorktreeManager;
  for (let fixes = 0; ; fixes++) {
    yield* Console.log(`${ticket.label} is checking with \`${command}\` on branch ${worktree.branch}`);
    const run = yield* worktrees.runCommand({ worktree, command, timeLimit: check.timeLimit });
    if (run._tag === 'Exited' && run.exitCode === 0) {
      yield* Console.log(`${ticket.label} passed the check`);
      return true;
    }
    yield* Console.log(`${ticket.label} failed the check: ${verdictOf(run, check.timeLimit)}`);
    if (fixes >= check.fixAttempts) {
      return false;
    }
    yield* Console.log(`${ticket.label} is sending the fix prompt (${fixes + 1} of ${check.fixAttempts})`);
    yield* harness.run(fixPromptOf(check, command, run), { label: `ticket-${ticket.id}-fix-${fixes + 1}` });
  }
});
