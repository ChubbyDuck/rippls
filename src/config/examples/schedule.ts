/** Copy to `rippls.config.ts` at the repository Rippls should process and set the window and timezone. */
export const harnessFileConfig = {
  agents: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
  schedule: [
    {
      agents: [{ name: 'Cursor' }],
      rule: {
        freq: 'DAILY',
        from: '18:00',
        to: '09:00',
        tzid: 'UTC',
      },
    },
  ],
};
