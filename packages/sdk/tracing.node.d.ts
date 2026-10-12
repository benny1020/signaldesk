import type { SignalDeskClient } from './index.js';
export type TraceContext = { traceId: string; spanId: string; flags: number };
export function parseTraceparent(value?: string): TraceContext | null;
export class SignalDeskTracing {
  constructor(options: {
    client: SignalDeskClient;
    propagateOrigins?: string[];
    trustIncomingContext?: boolean;
    fetchImpl?: typeof fetch;
  });
  current(): TraceContext | null;
  server<T extends { status: number }>(
    input: {
      method: string;
      route: string;
      headers?: Headers | { traceparent?: string };
      caller?: string;
      entry?: boolean;
    },
    fn: (ctx: TraceContext) => Promise<T>,
  ): Promise<T>;
  fetch(
    input: string | URL,
    init?: RequestInit,
    options?: { routeTemplate?: string; peerService?: string; resendCount?: number },
  ): Promise<Response>;
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    attributes?: Record<string, string | number | boolean>,
  ): boolean;
}
