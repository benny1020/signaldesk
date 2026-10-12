export type FlowIdentity = {
  name: string;
  type: 'workload' | 'caller' | 'dependency';
  environment: string;
  region: string;
  module: string;
};
export type FlowNode = FlowIdentity & { id: string; owner: string | null; regions?: string[] };
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  direction: 'inbound' | 'outbound';
  protocol: string;
  route: string;
  method: string;
  count: number;
  errors: number;
  clientErrors: number;
  throttled: number;
  timeouts: number;
  retries: number;
  paired: number;
  parentRequests: number;
  impactedRequests: number;
  recoveredRequests: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
  firstSeen: number;
  lastSeen: number;
};
export type FlowEvidence = {
  traceId: string;
  spanId: string;
  service: string;
  environment: string;
  region: string;
  module: string;
  instanceId: string;
  timestamp: number;
  durationMs: number;
  failed: boolean;
  statusCode: number | null;
  errorType: string | null;
  resend: number;
  parentDurationMs: number | null;
  parentFailed: boolean | null;
  parentRoute: string | null;
};
export type RequestFlow = {
  from: number;
  to: number;
  stepMs: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  selectedEdge: string | null;
  buckets: { timestamp: number; count: number; errors: number; averageMs: number; p95Ms: number }[];
  histogram: { timestamp: number; bin: number; count: number }[];
  durationBounds: number[];
  evidence: FlowEvidence[];
  truncated: boolean;
  source: 'retained-observed-spans';
};
import { z } from 'zod';
import { dimensionSchema } from './resource.ts';
export const dependencyMonitorSchema = z
  .object({
    ...dimensionSchema,
    name: z.string().min(1).max(160),
    service: z.string().min(1).max(100),
    environment: z.string().min(1).max(50),
    dependency: z.string().min(1).max(2000),
    route: z.string().min(1).max(200),
    method: z.string().min(1).max(20),
    indicator: z.enum(['error_pct', 'p95_ms']),
    threshold: z.number().positive().max(86400000),
    minimumRequests: z.number().int().min(1).max(1000000).default(20),
    windowMinutes: z.number().int().min(1).max(1440).default(5),
    enabled: z.boolean().default(true),
  })
  .refine(
    (d) => d.indicator !== 'error_pct' || d.threshold <= 100,
    'Failure percentage must be at most 100',
  );
export type DependencyMonitor = z.infer<typeof dependencyMonitorSchema> & {
  id: string;
  workspace: 'demo' | 'live';
  createdAt: number;
  updatedAt: number;
  revision: number;
};

export type DependencyStatus = {
  id: string;
  workspace: 'live' | 'demo';
  at: number;
  revision: number;
  status: 'unknown' | 'violated' | 'healthy';
  observations: {
    edge: string;
    region: unknown;
    targetRegion: unknown;
    count: number;
    value: number;
    status: string;
  }[];
};
