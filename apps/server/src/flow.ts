import { createHash } from 'node:crypto';
import { durationBounds, flowKeys } from './flow-sql.ts';
import type {
  QueryScope,
  RequestFlow,
  FlowEdge,
  FlowNode,
  FlowIdentity,
  CatalogService,
  Team,
} from '../../../packages/contracts/src/index.ts';
import type { Storage } from './storage.ts';
import type { TelemetryStore } from './store.ts';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
export async function requestFlow(
  store: Storage,
  telemetry: TelemetryStore,
  scope: QueryScope,
  selected?: string,
): Promise<RequestFlow> {
  if (!telemetry.aggregate)
    throw Object.assign(new Error('Request flow requires server aggregation'), { statusCode: 501 });
  const [all, catalog, teams] = await Promise.all([
    telemetry.aggregate('flowEdges', scope),
    store.list<CatalogService>('catalog-service', scope.workspace),
    store.list<Team>('team', scope.workspace),
  ]);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = all.rows.map((row) => {
    const node = (prefix: 's' | 't') => {
      const val = (k: string) => String(row[prefix + '_' + k] ?? 'unknown');
      const info: FlowIdentity = {
        name: val('name'),
        type: val('type') as FlowIdentity['type'],
        environment: val('env'),
        region: val('region'),
        module: val('module'),
      };
      const id = hash(info),
        service = catalog.find((c) => c.name === info.name || c.aliases.includes(info.name));
      nodes.set(id, {
        ...info,
        id,
        owner:
          info.type === 'workload'
            ? (teams.find((t) => t.id === service?.teamId)?.name ?? null)
            : null,
      });
      return id;
    };
    const number = (k: string) => Number(row[k] ?? 0);
    return {
      id: hash(flowKeys.map((k) => String(row[k]))),
      source: node('s'),
      target: node('t'),
      direction: String(row.direction) as FlowEdge['direction'],
      route: String(row.route),
      method: String(row.method),
      protocol: String(row.protocol),
      count: number('count'),
      errors: number('errors'),
      clientErrors: number('client_errors'),
      throttled: number('throttled'),
      timeouts: number('timeouts'),
      retries: number('retries'),
      paired: number('paired'),
      parentRequests: number('parent_requests'),
      impactedRequests: number('impacted_requests'),
      recoveredRequests: number('recovered_requests'),
      entryRequests: number('entry_requests'),
      impactedEntries: number('impacted_entries'),
      recoveredEntries: number('recovered_entries'),
      averageMs: number('average_ms'),
      p50Ms: number('p50_ms'),
      p95Ms: number('p95_ms'),
      maximumMs: number('maximum_ms'),
      firstSeen: number('first_seen'),
      lastSeen: number('last_seen'),
    };
  });
  const edge = selected
    ? edges.find((e) => e.id === selected)
    : [...edges].sort(
        (a, b) =>
          (b.direction === 'outbound' ? 1 : 0) - (a.direction === 'outbound' ? 1 : 0) ||
          b.errors - a.errors ||
          b.p95Ms - a.p95Ms,
      )[0];
  if (selected && !edge)
    throw Object.assign(
      new Error('Selected connection is outside this scope; clear the selection'),
      { statusCode: 404 },
    );
  if (!edge)
    return {
      from: scope.from,
      to: scope.to,
      stepMs: all.stepMs,
      nodes: [],
      edges: [],
      selectedEdge: null,
      buckets: [],
      histogram: [],
      durationBounds,
      evidence: [],
      truncated: all.truncated,
      source: 'retained-observed-spans',
    };
  const row = all.rows[edges.indexOf(edge)],
    filter = flowKeys.map((k) => String(row[k]));
  const [buckets, histogram, evidence] = await Promise.all(
    ['flowBuckets', 'flowHistogram', 'flowEvidence'].map((kind) =>
      telemetry.aggregate!(kind as 'flowBuckets', { ...scope, flowFilter: filter }),
    ),
  );
  return {
    from: scope.from,
    to: scope.to,
    stepMs: all.stepMs,
    nodes: [...nodes.values()],
    edges,
    selectedEdge: edge.id,
    buckets: buckets.rows.map((r) => ({
      timestamp: Number(r.bucket),
      count: Number(r.count),
      errors: Number(r.errors),
      averageMs: Number(r.average_ms),
      p95Ms: Number(r.p95_ms),
    })),
    histogram: histogram.rows.map((r) => ({
      timestamp: Number(r.bucket),
      bin: Number(r.bin),
      count: Number(r.count),
    })),
    durationBounds,
    evidence: evidence.rows.map((r) => ({
      traceId: String(r.trace_id),
      spanId: String(r.span_id),
      service: String(r.service),
      environment: String(r.environment),
      region: String(r.region),
      module: String(r.module),
      instanceId: String(r.instance_id),
      timestamp: Number(r.time),
      durationMs: Number(r.duration),
      failed: Number(r.failed) === 1,
      statusCode: r.status_code === null ? null : Number(r.status_code),
      errorType: r.error_type === null ? null : String(r.error_type),
      resend: Number(r.resend),
      parentDurationMs: r.parent_duration === null ? null : Number(r.parent_duration),
      parentFailed: r.parent_failed === null ? null : Number(r.parent_failed) === 1,
      parentRoute: r.parent_route === null ? null : String(r.parent_route),
      entryDurationMs: r.entry_duration === null ? null : Number(r.entry_duration),
      entryFailed: r.entry_failed === null ? null : Number(r.entry_failed) === 1,
      entryRoute: r.entry_route === null ? null : String(r.entry_route),
      entryService: r.entry_service === null ? null : String(r.entry_service),
    })),
    truncated: all.truncated || buckets.truncated || histogram.truncated,
    source: 'retained-observed-spans',
  };
}
