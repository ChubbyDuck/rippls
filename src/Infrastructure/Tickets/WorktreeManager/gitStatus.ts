import { ChildProcess } from 'effect/unstable/process';

// Lists every change of the worktree, NUL-separated. Untracked files are listed one
// by one whatever `status.showUntrackedFiles` says, and ignored files never are.
export const gitStatusIn = (directory: string) =>
  ChildProcess.make('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: directory });

// The paths `git status --porcelain -z` lists as changed, with the untracked ones
// apart. A rename or a copy is followed by the path it came from, which is skipped:
// the path it went to stands for the change.
export const changesOf = (porcelain: string) => {
  const fields = porcelain.split('\0');
  const changes: Array<{ readonly path: string; readonly untracked: boolean }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? '';
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    changes.push({ path: field.slice(3), untracked: status === '??' });
    if (status.includes('R') || status.includes('C')) {
      index++;
    }
  }
  return changes;
};
