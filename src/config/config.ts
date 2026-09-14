import type { HarnessFileConfig } from '~/Core/Shared/Domain/HarnessConfig';

export const harnessFileConfig: HarnessFileConfig = {
  agents: [{ name: 'Cursor' }],
  otlpTraceUrl: 'http://127.0.0.1:27686/v1/traces',
  source: {
    _tag: 'folder',
    ticketsDir: '/Users/chubbyduck/_Projects/pet/rippls/.agents/tickets',
  },
};
