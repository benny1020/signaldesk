import { z } from 'zod';
import { dimensionSchema, type ResourceSelector, type ResourceIdentity } from './resource.ts';
export * from './resource.ts';
export const workspaceSchema = z.enum(['demo', 'live']);
export type Workspace = z.infer<typeof workspaceSchema>;
export const metricNames = [
  'request_rate',
  'error_pct',
  'latency_p95_ms',
  'cpu_pct',
  'memory_pct',
  'probe_up',
  'probe_duration_ms',
  'ai_cost_usd',
] as const;
const base = {
  ...dimensionSchema,
  host: z.string().max(128).optional(),
  id: z.string().min(1).max(128).optional(),
  timestamp: z.number().int().nonnegative(),
  service: z.string().min(1).max(100),
  environment: z.string().min(1).max(50).default('production'),
};
const attributes = z
  .record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean()]))
  .default({});
export const metricSchema = z
  .object({
    ...base,
    kind: z.literal('metric'),
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z_:][a-zA-Z0-9_.:]*$/),
    value: z.number().finite(),
    metricType: z.enum(['gauge', 'counter', 'histogram']).optional(),
    unit: z.string().max(100).optional(),
    startTimestamp: z.number().int().nonnegative().optional(),
    temporality: z.enum(['delta', 'cumulative']).optional(),
    histogram: z
      .object({
        count: z.number().int().nonnegative(),
        sum: z.number().finite(),
        bounds: z.array(z.number().finite()).max(200),
        bucketCounts: z.array(z.number().int().nonnegative()).max(201),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if ((metricNames as readonly string[]).includes(m.name) && m.value < 0)
      ctx.addIssue({
        code: 'custom',
        message: 'Operational metrics must be nonnegative',
        path: ['value'],
      });
    if (m.metricType === 'counter' && m.value < 0)
      ctx.addIssue({
        code: 'custom',
        message: 'Monotonic counters must be nonnegative',
        path: ['value'],
      });
    if (m.metricType === 'histogram' && !m.histogram)
      ctx.addIssue({
        code: 'custom',
        message: 'Histogram distribution required',
        path: ['histogram'],
      });
    if (
      m.histogram &&
      (m.histogram.bucketCounts.length !== m.histogram.bounds.length + 1 ||
        m.histogram.bucketCounts.reduce((n, v) => n + v, 0) !== m.histogram.count ||
        m.histogram.bounds.some((b, i) => i > 0 && b <= m.histogram!.bounds[i - 1]))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid histogram distribution',
        path: ['histogram'],
      });
    if (['cpu_pct', 'memory_pct', 'error_pct'].includes(m.name) && m.value > 100)
      ctx.addIssue({
        code: 'custom',
        message: 'Percentage must be between 0 and 100',
        path: ['value'],
      });
    if (m.name === 'probe_up' && ![0, 1].includes(m.value))
      ctx.addIssue({ code: 'custom', message: 'probe_up must be 0 or 1', path: ['value'] });
  });
export const logSchema = z.object({
  ...base,
  kind: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().min(1).max(4000),
  traceId: z.string().max(128).optional(),
  attributes,
});
export const spanSchema = z.object({
  ...base,
  kind: z.literal('span'),
  spanKind: z.enum(['internal', 'server', 'client', 'producer', 'consumer']).optional(),
  traceId: z.string().min(1).max(128),
  spanId: z.string().min(1).max(128),
  parentSpanId: z.string().max(128).optional(),
  name: z.string().min(1).max(200),
  durationMs: z.number().nonnegative().max(86400000),
  status: z.enum(['ok', 'error']),
  attributes,
  ai: z
    .object({
      provider: z.string().max(100),
      modelVersion: z.string().max(100).optional(),
      promptVersion: z.string().max(100).optional(),
      sessionId: z.string().max(128).optional(),
      stage: z.enum(['generation', 'tool', 'retrieval', 'evaluation']).optional(),
      failureType: z.string().max(100).optional(),
      model: z.string().max(100),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
      costSource: z.string().min(1).max(200).optional(),
      ttftMs: z.number().nonnegative().optional(),
      evaluation: z
        .object({
          name: z.string().max(100),
          score: z.number().min(0).max(1),
          source: z.enum(['human', 'rule', 'model']),
          evaluator: z.string().min(1).max(100),
        })
        .optional(),
    })
    .refine((a) => a.costUsd === undefined || !!a.costSource, 'Cost requires costSource provenance')
    .optional(),
});
export const eventSchema = z.discriminatedUnion('kind', [metricSchema, logSchema, spanSchema]);
export const ingestSchema = z.object({
  workspace: workspaceSchema.default('live'),
  events: z.array(eventSchema).min(1).max(1000),
});
export type TelemetryEvent = z.infer<typeof eventSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type Log = z.infer<typeof logSchema>;
export type Span = z.infer<typeof spanSchema>;
export const ruleSchema = z.object({
  ...dimensionSchema,
  groupBy: z.enum(['resource', 'region', 'service']).default('resource'),
  name: z.string().min(1).max(160),
  service: z.string().min(1).max(100),
  environment: z.string().min(1).max(50).default('production'),
  metric: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z_:][a-zA-Z0-9_.:]*$/),
  operator: z.enum(['gt', 'lt']),
  threshold: z.number().finite(),
  durationSec: z.number().int().min(0).max(86400).default(0),
  severity: z.enum(['critical', 'warning']).default('warning'),
  noData: z.enum(['ignore', 'alert']).default('alert'),
  enabled: z.boolean().default(true),
});
export type RuleInput = Omit<z.infer<typeof ruleSchema>, 'groupBy'> & {
  groupBy?: 'resource' | 'region' | 'service';
};
export type Rule = RuleInput & {
  id: string;
  workspace: Workspace;
  pendingSince: number | null;
  revision?: number;
};
export type Alert = ResourceSelector & {
  dependency?: string;
  dependencyRoute?: string;
  groupKey?: string;
  id: string;
  workspace: Workspace;
  ruleId: string;
  title: string;
  service: string;
  environment: string;
  severity: 'critical' | 'warning';
  status: 'firing' | 'resolved';
  reason: 'threshold' | 'no_data';
  value: number | null;
  createdAt: number;
  resolvedAt: number | null;
  acknowledged: boolean;
  snoozedUntil: number;
  acknowledgedBy?: string;
  snoozedBy?: string;
  snoozeReason?: string;
  lastNotifiedAt?: number;
  notificationSequence?: number;
};
export type Incident = ResourceSelector & {
  id: string;
  workspace: Workspace;
  title: string;
  service: string;
  environment: string;
  severity: 'critical' | 'warning';
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  owner: string;
  alertId?: string;
  alertIds?: string[];
  createdAt: number;
  updatedAt: number;
  timeline: { id: string; time: number; text: string; actor: string }[];
};
export type QueryScope = ResourceSelector & {
  workspace: Workspace;
  from: number;
  to: number;
  service?: string;
  environment?: string;
  limit?: number;
  cursor?: string;
  search?: string;
  level?: string;
  traceId?: string;
  metric?: Metric['name'];
  route?: string;
  eventId?: string;
  flowFilter?: string[];
};
export type Page<T> = { items: T[]; nextCursor: string | null; truncated: boolean };
export type Series = {
  window?: { from: number; to: number };
  name: string;
  unit: string;
  points: [number, number][];
  stepMs?: number;
};
export type ServiceSummary = {
  name: string;
  environment: string;
  requestRate: number | null;
  errorPct: number | null;
  latency: number | null;
  lastSeen: number;
  instances: number;
  regions: string[];
  modules: string[];
  status: 'healthy' | 'degraded' | 'unknown';
};
export type HostSummary = ResourceIdentity & {
  id: string;
  name: string;
  cpu: number | null;
  memory: number | null;
  lastSeen: number;
};
export type ResourceSummary = ResourceIdentity & {
  id: string;
  observedApplication?: boolean;
  host?: string;
  firstSeen: number;
  lastSeen: number;
  retired: boolean;
  requestRate: number | null;
  errorPct: number | null;
  latency: number | null;
  status: 'healthy' | 'degraded' | 'unknown' | 'retired';
};
export type RuleState = {
  id: string;
  workspace: Workspace;
  ruleId: string;
  groupKey: string;
  resource: ResourceSelector;
  pendingSince: number | null;
  lastSeen: number;
  configuration?: string;
};
export type Dashboard = {
  resources: ResourceSummary[];
  inventoryTruncated: boolean;
  services: ServiceSummary[];
  hosts: HostSummary[];
  series: Record<string, Series>;
  logs: Log[];
  spans: Span[];
  alerts: Alert[];
  incidents: Incident[];
  rules: Rule[];
  truncated: boolean;
  window: { from: number; to: number };
  ai: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    reportedCost: number | null;
    costCoverage: number;
    errorPct: number | null;
    p95: number | null;
    models: { name: string; calls: number; cost: number | null }[];
    evaluations: {
      name: string;
      score: number;
      source: string;
      evaluator: string;
      traceId: string;
    }[];
  };
};

export * from './operations.ts';
export * from './flow.ts';
