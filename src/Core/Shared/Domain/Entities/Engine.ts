import type { EngineId } from '../Properties/EngineId';
import { runnerIdFrom } from '../Properties/RunnerId';
import { Runner } from './Runner';

export class Engine {
  private nextRunner = 0;

  constructor(readonly id: EngineId) {}

  spawn(): Runner {
    return new Runner({ id: runnerIdFrom(this.id, String(this.nextRunner++)) });
  }
}
