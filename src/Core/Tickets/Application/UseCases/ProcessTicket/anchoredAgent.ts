import type { Agent } from '~/Core/Shared/Ports/Agent';

export const anchoredAgent = (agent: Agent, cwd: string): Agent => ({
  name: agent.name,
  model: agent.model,
  run: (prompt, options) => agent.run(prompt, { ...options, cwd }),
});
