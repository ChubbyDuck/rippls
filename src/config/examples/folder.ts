/** Copy to `rippls.config.ts` at the repository Rippls should process. */
export const engineFileConfig = {
  harnesses: [{ name: 'Codex' }, { name: 'Cursor' }, { name: 'Claude' }, { name: 'OpenCode' }],
  otlpTraceUrl: 'http://127.0.0.1:4318/v1/traces',
  source: {
    _tag: 'folder',
    ticketsDir: '.agents/tickets',
  },
};
