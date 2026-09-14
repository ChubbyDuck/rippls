/** Copy to `rippls.config.ts` at the repository Rippls should process and set `teamId`. */
export const harnessFileConfig = {
  agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
  source: {
    _tag: 'linear',
    teamId: 'your-team-id',
  },
};
