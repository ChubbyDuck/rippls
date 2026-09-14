import { Schema } from 'effect';

import { RunnerId } from '../Properties/RunnerId';

export class Runner extends Schema.Class<Runner>('Runner')({
  id: RunnerId,
}) {}
