import type { TelemetryEvent, Workspace, ResourceSelector } from '../contracts/src/index';
export class SignalDeskClient {
  constructor(options?: {
    endpoint?: string;
    resource?: ResourceSelector;
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
