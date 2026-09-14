import type { HarnessId } from '../Properties/HarnessId';
import { runnerIdFrom } from '../Properties/RunnerId';
import { Runner } from './Runner';

export class Harness {
  private nextRunner = 0;

  constructor(readonly id: HarnessId) {}

  spawn(): Runner {
    return new Runner({ id: runnerIdFrom(this.id, String(this.nextRunner++)) });
  }
}
