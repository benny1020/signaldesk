import { z } from 'zod';
import { dimensionSchema } from './resource.ts';
export const teamSchema = z.object({
  name: z.string().min(1).max(100),
  contact: z.string().max(200).default(''),
});
export const catalogSchema = z.object({
  name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(100)).max(20).default([]),
  teamId: z.string().max(128).nullable().default(null),
  repository: z
    .union([
      z
        .url()
        .max(2000)
        .refine(
          (value) => ['http:', 'https:'].includes(new URL(value).protocol),
          'Only HTTP(S) links are supported',
        ),
      z.literal(''),
    ])
    .default(''),
  runbook: z
    .union([
      z
        .url()
        .max(2000)
        .refine(
          (value) => ['http:', 'https:'].includes(new URL(value).protocol),
          'Only HTTP(S) links are supported',
        ),
      z.literal(''),
    ])
    .default(''),
  criticality: z.enum(['critical', 'standard', 'low']).default('standard'),
  regions: z.array(z.string().min(1).max(100)).max(50).default([]),
  description: z.string().max(1000).default(''),
});
export const routeSchema = z.object({
  ...dimensionSchema,
  name: z.string().min(1).max(100),
  service: z.string().max(100).optional(),
  environment: z.string().max(50).optional(),
  teamId: z.string().max(128).optional(),
  severity: z.enum(['critical', 'warning']).optional(),
  channelIds: z.array(z.string().min(1).max(128)).min(1).max(20),
  enabled: z.boolean().default(true),
  repeatMinutes: z.number().int().min(1).max(1440).default(30),
  notifyRecovery: z.boolean().default(true),
});
export const maintenanceSchema = z
  .object({
    ...dimensionSchema,
    name: z.string().min(1).max(100),
    service: z.string().max(100).optional(),
    environment: z.string().max(50).optional(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1000),
  })
  .refine(
    (x) => x.to > x.from && x.to - x.from <= 7 * 86400000,
    'Maintenance must be ordered and at most 7 days',
  );
export const sloSchema = z.object({
  ...dimensionSchema,
  name: z.string().min(1).max(160),
  service: z.string().min(1).max(100),
  environment: z.string().min(1).max(50).default('production'),
  route: z.string().max(200).optional(),
  objective: z.number().min(90).max(99.9999),
  indicator: z.enum(['availability', 'latency']).default('availability'),
  latencyMs: z.number().positive().max(86400000).default(1000),
  windowMinutes: z.number().int().min(5).max(10080).default(60),
  minimumRequests: z.number().int().min(1).max(1000000).default(10),
  alertBurnRate: z.number().positive().max(10000).default(2),
  enabled: z.boolean().default(true),
});
type Entity = {
  id: string;
  workspace: 'demo' | 'live';
  createdAt: number;
  updatedAt: number;
  revision: number;
};
export type Team = z.infer<typeof teamSchema> & Entity;
export type CatalogService = z.infer<typeof catalogSchema> & Entity;
export type NotificationRoute = z.infer<typeof routeSchema> & Entity;
export type Maintenance = z.infer<typeof maintenanceSchema> & Entity & { actor: string };
export type SLO = z.infer<typeof sloSchema> & Entity;
export type SLOResult = {
  definition: SLO;
  total: number;
  bad: number;
  successPct: number | null;
  budgetRemainingPct: number | null;
  burnRate: number | null;
  status: 'healthy' | 'violated' | 'insufficient';
  from: number;
  to: number;
  source: 'observed-server-spans';
};
export const datasetSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  cases: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        expected: z.record(
          z.string().max(100),
          z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
        ),
        actual: z.record(
          z.string().max(100),
          z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
        ),
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (cases) => new Set(cases.map((c) => c.id)).size === cases.length,
      'Case IDs must be unique',
    ),
});
export type EvaluationDataset = z.infer<typeof datasetSchema> & Entity;
export const experimentSchema = z.object({
  datasetId: z.string().min(1).max(128),
  modelVersion: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  baselineId: z.string().max(128).optional(),
  actuals: z
    .record(
      z.string().max(100),
      z.record(
        z.string().max(100),
        z.union([z.string().max(1000), z.number().finite(), z.boolean()]),
      ),
    )
    .optional(),
});
export type EvaluationRun = Entity &
  z.infer<typeof experimentSchema> & {
    datasetVersion: string;
    evaluator: 'structured-exact-match-v1';
    score: number;
    coverage: number;
    results: { caseId: string; score: number; failedFields: string[] }[];
    regression: number | null;
  };
export type AggregateKind =
  | 'logBuckets'
  | 'errorGroups'
  | 'apis'
  | 'sli'
  | 'ai'
  | 'relations'
  | 'metricSeries'
  | 'traces'
  | 'flowEdges'
  | 'flowBuckets'
  | 'flowHistogram'
  | 'flowEvidence';
export type AggregateResult = {
  rows: Record<string, string | number | null>[];
  truncated: boolean;
  from: number;
  to: number;
  stepMs: number;
  source: 'retained-telemetry-sql';
};
