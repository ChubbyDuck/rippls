import type { Harness } from '~/Core/Shared/Ports/Harness';

export const harnessInWorktree = (harness: Harness, cwd: string): Harness => ({
  name: harness.name,
  model: harness.model,
  run: (prompt, options) => harness.run(prompt, { ...options, cwd }),
});
