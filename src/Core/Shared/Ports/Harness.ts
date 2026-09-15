import type { Effect } from 'effect';

import type { HarnessRuntimeError } from '~/Core/Shared/Domain/Exceptions/HarnessRuntimeError';

export type ModelTier = 'low' | 'mid' | 'high';

export type ModelGeneration = 'current' | 'previous';

// Harness-agnostic filter. Each provided field must match. Omitted fields do not constrain.
export interface ModelDemand {
  readonly tier?: ModelTier;
  readonly fast?: boolean;
  readonly generation?: ModelGeneration;
}

export interface HarnessRunOptions {
  // Names the per-run log file, so several runs of one ticket do not overwrite each other.
  readonly label: string;
  // Substrings the harness can emit to signal an outcome. The matched one is returned.
  readonly completionSignal?: readonly string[];
  // Directory of the already-created ticket worktree the harness runs in.
  readonly cwd?: string;
  // Shared model filter for this run. When omitted, the harness's default model is used.
  readonly model?: ModelDemand;
}

export interface HarnessRunResult {
  // The matched completion signal, or undefined when the harness emitted none.
  readonly completionSignal: string | undefined;
}

// A reusable coding integration. Each run invokes a new Agent using the selected model.
export interface Harness {
  readonly name: string;
  // The default model for this harness. Always available; a run demand may pick another.
  readonly model: string;
  readonly run: (prompt: string, options: HarnessRunOptions) => Effect.Effect<HarnessRunResult, HarnessRuntimeError>;
}
