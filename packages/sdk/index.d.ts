import type { TelemetryEvent, Workspace } from '../contracts/src/index';
export class SignalDeskClient {
  constructor(options?: {
    endpoint?: string;
    token?: string;
    workspace?: Workspace;
    batchSize?: number;
    maxQueue?: number;
    fetchImpl?: typeof fetch;
    onError?: (error: Error) => void;
  });
  queue: TelemetryEvent[];
  dropped: number;
  emit(event: TelemetryEvent): boolean;
  flush(): Promise<{
    accepted: number;
    duplicates?: number;
    rejected?: number;
    retryPending?: number;
  }>;
}
