import type { Effect } from 'effect';

import type { AgentRuntimeError } from '~/Core/Shared/Domain/Exceptions/AgentRuntimeError';

export type ModelTier = 'low' | 'mid' | 'high';

export type ModelGeneration = 'current' | 'previous';

// Agent-agnostic filter. Each provided field must match. Omitted fields do not constrain.
export interface ModelDemand {
  readonly tier?: ModelTier;
  readonly fast?: boolean;
  readonly generation?: ModelGeneration;
}

export interface AgentRunOptions {
  // Names the per-run log file, so several runs of one ticket do not overwrite each other.
  readonly label: string;
  // Substrings the agent can emit to signal an outcome. The matched one is returned.
  readonly completionSignal?: readonly string[];
  // Directory of the already-created ticket worktree the agent runs in.
  readonly cwd?: string;
  // Shared model filter for this run. When omitted, the agent's default model is used.
  readonly model?: ModelDemand;
}

export interface AgentRunResult {
  // The matched completion signal, or undefined when the agent emitted none.
  readonly completionSignal: string | undefined;
}

export interface Agent {
  readonly name: string;
  // The default model for this agent. Always available; a run demand may pick another.
  readonly model: string;
  readonly run: (prompt: string, options: AgentRunOptions) => Effect.Effect<AgentRunResult, AgentRuntimeError>;
}
