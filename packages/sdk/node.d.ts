import { SignalDeskClient } from './index.js';
export class DurableSignalDeskClient extends SignalDeskClient {
  constructor(
    options: NonNullable<ConstructorParameters<typeof SignalDeskClient>[0]> & { queuePath: string },
  );
  close(): void;
}
