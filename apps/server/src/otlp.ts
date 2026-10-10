import { z } from 'zod';
import { ingestSchema, type TelemetryEvent } from '../../../packages/contracts/src/index.ts';
const value = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
});
const attr = z.object({ key: z.string().max(100), value });
const attrs = z.array(attr).max(200).optional();
const resource = z.object({ attributes: attrs }).optional();
const nano = z.string().regex(/^\d+$/);
const map = (input: z.infer<typeof attrs>) =>
  Object.fromEntries(
    (input ?? []).map((a) => [
      a.key,
      a.value.stringValue ??
        a.value.doubleValue ??
        a.value.boolValue ??
        Number(a.value.intValue ?? 0),
    ]),
  );
const identity = (attributes: Record<string, string | number | boolean>) => ({
  service: String(attributes['service.name'] ?? 'unknown-service'),
  environment: String(attributes['deployment.environment.name'] ?? 'production'),
  module: attributes['signaldesk.module'] ?? attributes['service.namespace'],
  region: attributes['cloud.region'],
  zone: attributes['cloud.availability_zone'],
  cluster: attributes['k8s.cluster.name'],
  namespace: attributes['k8s.namespace.name'],
  instanceId: attributes['service.instance.id'] ?? attributes['k8s.pod.uid'],
  host: attributes['host.id'] ?? attributes['host.name'],
});
export function otlpLogs(body: unknown): TelemetryEvent[] {
  const input = z
    .object({
      resourceLogs: z
        .array(
          z.object({
            resource,
            scopeLogs: z
              .array(
                z.object({
                  logRecords: z
                    .array(
                      z.object({
                        timeUnixNano: nano,
                        observedTimeUnixNano: nano.optional(),
                        severityNumber: z.number().int().min(0).max(24).optional(),
                        body: value,
                        traceId: z.string().max(128).optional(),
                        attributes: attrs,
                      }),
                    )
                    .max(1000),
                }),
              )
              .max(100),
          }),
        )
        .max(100),
    })
    .parse(body);
  const events = input.resourceLogs.flatMap((rs) =>
    rs.scopeLogs.flatMap((ss) =>
      ss.logRecords.map((l) => ({
        kind: 'log',
        ...identity(map(rs.resource?.attributes)),
        timestamp: Number(BigInt(l.timeUnixNano) / 1000000n),
        level:
          (l.severityNumber ?? 9) >= 17
            ? 'error'
            : (l.severityNumber ?? 9) >= 13
              ? 'warn'
              : (l.severityNumber ?? 9) >= 9
                ? 'info'
                : 'debug',
        message:
          l.body.stringValue ??
          String(l.body.intValue ?? l.body.doubleValue ?? l.body.boolValue ?? ''),
        traceId: l.traceId,
        attributes: map(l.attributes),
      })),
    ),
  );
  return events.length ? ingestSchema.parse({ events }).events : [];
}
export function otlpMetrics(body: unknown): TelemetryEvent[] {
  const point = z.object({
    attributes: attrs,
    timeUnixNano: nano,
    startTimeUnixNano: nano.optional(),
    asDouble: z.number().finite().optional(),
    asInt: z.union([z.string(), z.number()]).optional(),
  });
  const hist = point.extend({
    count: z.union([z.string(), z.number()]),
    sum: z.number().finite().optional(),
    bucketCounts: z.array(z.union([z.string(), z.number()])).max(201),
    explicitBounds: z.array(z.number().finite()).max(200),
  });
  const input = z
    .object({
      resourceMetrics: z
        .array(
          z.object({
            resource,
            scopeMetrics: z
              .array(
                z.object({
                  metrics: z
                    .array(
                      z.object({
                        name: z.string().min(1).max(100),
                        unit: z.string().max(100).optional(),
                        gauge: z.object({ dataPoints: z.array(point).max(1000) }).optional(),
                        sum: z
                          .object({
                            dataPoints: z.array(point).max(1000),
                            aggregationTemporality: z.number().optional(),
                            isMonotonic: z.boolean().optional(),
                          })
                          .optional(),
                        histogram: z
                          .object({
                            dataPoints: z.array(hist).max(1000),
                            aggregationTemporality: z.number().optional(),
                          })
                          .optional(),
                      }),
                    )
                    .max(1000),
                }),
              )
              .max(100),
          }),
        )
        .max(100),
    })
    .parse(body);
  const events: unknown[] = [];
  for (const rs of input.resourceMetrics)
    for (const ss of rs.scopeMetrics)
      for (const m of ss.metrics) {
        if (Number(!!m.gauge) + Number(!!m.sum) + Number(!!m.histogram) !== 1)
          throw Object.assign(
            new Error('Exactly one gauge, sum or explicit histogram is required'),
            { statusCode: 400 },
          );
        for (const p of m.gauge?.dataPoints ?? m.sum?.dataPoints ?? m.histogram?.dataPoints ?? []) {
          const h = 'bucketCounts' in p ? (p as z.infer<typeof hist>) : null;
          if (
            h &&
            (h.bucketCounts.length !== h.explicitBounds.length + 1 ||
              h.explicitBounds.some((v, i) => i > 0 && v <= h.explicitBounds[i - 1]) ||
              h.bucketCounts.reduce<number>((n, b) => n + Number(b), 0) !== Number(h.count))
          )
            throw Object.assign(new Error('Histogram bounds/counts are inconsistent'), {
              statusCode: 400,
            });
          events.push({
            kind: 'metric',
            ...identity(map(rs.resource?.attributes)),
            timestamp: Number(BigInt(p.timeUnixNano) / 1000000n),
            name: m.name,
            value: h ? (h.sum ?? 0) / (Number(h.count) || 1) : (p.asDouble ?? Number(p.asInt)),
            metricType: h ? 'histogram' : m.sum?.isMonotonic ? 'counter' : 'gauge',
            unit: m.unit,
            startTimestamp: p.startTimeUnixNano
              ? Number(BigInt(p.startTimeUnixNano) / 1000000n)
              : undefined,
            temporality:
              (m.sum?.aggregationTemporality ?? m.histogram?.aggregationTemporality) === 1
                ? 'delta'
                : 'cumulative',
            histogram: h
              ? {
                  count: Number(h.count),
                  sum: h.sum ?? 0,
                  bounds: h.explicitBounds,
                  bucketCounts: h.bucketCounts.map(Number),
                }
              : undefined,
          });
        }
      }
  return events.length ? ingestSchema.parse({ events }).events : [];
}
