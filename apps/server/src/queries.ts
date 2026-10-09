import type {
  Dashboard,
  QueryScope,
  Metric,
  Log,
  Span,
} from '../../../packages/contracts/src/index.ts';
import { type TelemetryStore } from './store.ts';
import type { Storage } from './storage.ts';
import {
  identity,
  resourceKey,
  matchesResource,
  type ResourceSummary,
} from '../../../packages/contracts/src/index.ts';
import { createHash } from 'node:crypto';
export async function dashboard(
  store: Storage,
  scope: QueryScope,
  telemetry: TelemetryStore = store,
): Promise<Dashboard> {
  const [metricPage, logPage, spanPage] = await Promise.all([
    telemetry.query('metric', { ...scope, limit: 10000 }),
    telemetry.query('log', { ...scope, limit: 300 }),
    telemetry.query('span', { ...scope, limit: 1000 }),
  ]);
  const metrics = metricPage.items as Metric[],
    logs = logPage.items as Log[],
    spans = spanPage.items as Span[];
  const [latestPage, inventoryPage] = await Promise.all([
    telemetry.latestMetrics ? telemetry.latestMetrics({ ...scope, limit: 10000 }) : metricPage,
    telemetry.inventory ? telemetry.inventory({ ...scope, limit: 10000 }) : null,
  ]);
  const latest = new Map<string, Metric>(),
    metricsByResource = new Map<string, Metric[]>();
  for (const m of latestPage.items as Metric[]) {
    const key = resourceKey(m) + ':' + m.name;
    if (!latest.has(key)) latest.set(key, m);
  }
  for (const m of latest.values()) {
    const key = resourceKey(m),
      rows = metricsByResource.get(key) ?? [];
    rows.push(m);
    metricsByResource.set(key, rows);
  }
  const resources = new Map<string, ResourceSummary>();
  for (const r of inventoryPage?.items ?? []) resources.set(resourceKey(r), r);
  for (const m of latest.values()) {
    const key = resourceKey(m),
      r = resources.get(key) ?? {
        ...identity(m),
        id: createHash('sha256').update(key).digest('hex'),
        host: m.host,
        firstSeen: m.timestamp,
        lastSeen: m.timestamp,
        retired: false,
        requestRate: null,
        errorPct: null,
        latency: null,
        status: 'unknown',
      };
    resources.set(key, r);
  }
  const serviceMap = new Map<string, Dashboard['services'][number]>(),
    hostMap = new Map<string, Dashboard['hosts'][number]>();
  for (const [key, r] of resources) {
    const metric = (name: Metric['name']) => latest.get(key + ':' + name),
      fresh = (name: Metric['name']) => {
        const m = metric(name);
        return m && scope.to - m.timestamp <= 120000 ? m.value : null;
      };
    r.requestRate = fresh('request_rate');
    r.errorPct = fresh('error_pct');
    r.latency = fresh('latency_p95_ms');
    const observed = metricsByResource.get(key) ?? [],
      recent = observed.some((m) => scope.to - m.timestamp <= 120000);
    r.status = r.retired
      ? 'retired'
      : !recent ||
          (r.errorPct === null &&
            fresh('probe_up') === null &&
            fresh('cpu_pct') === null &&
            fresh('memory_pct') === null)
        ? 'unknown'
        : (r.errorPct ?? 0) > 1 || fresh('probe_up') === 0
          ? 'degraded'
          : 'healthy';
    if (r.host) {
      hostMap.set(key, {
        ...identity(r),
        id: r.id,
        name: r.host,
        cpu: fresh('cpu_pct'),
        memory: fresh('memory_pct'),
        lastSeen: Math.min(r.lastSeen, scope.to),
      });
    }
    if (
      r.retired ||
      (!!r.host &&
        !observed.some((m) =>
          ['request_rate', 'error_pct', 'latency_p95_ms', 'probe_up'].includes(m.name),
        ))
    )
      continue;
    const serviceKey = r.service + '\0' + r.environment,
      service = serviceMap.get(serviceKey) ?? {
        name: r.service,
        environment: r.environment,
        requestRate: null,
        errorPct: null,
        latency: null,
        lastSeen: 0,
        status: 'healthy',
        instances: 0,
        regions: [],
        modules: [],
      };
    service.instances++;
    service.lastSeen = Math.max(service.lastSeen, Math.min(r.lastSeen, scope.to));
    if (!service.regions.includes(r.region)) service.regions.push(r.region);
    if (!service.modules.includes(r.module)) service.modules.push(r.module);
    if (r.requestRate !== null) service.requestRate = (service.requestRate ?? 0) + r.requestRate;
    if (r.latency !== null) service.latency = Math.max(service.latency ?? 0, r.latency);
    if (r.status === 'degraded') service.status = 'degraded';
    else if (r.status === 'unknown' && service.status !== 'degraded') service.status = 'unknown';
    serviceMap.set(serviceKey, service);
  }
  for (const service of serviceMap.values()) {
    const parts = [...resources.values()].filter(
        (r) =>
          !r.retired &&
          r.service === service.name &&
          r.environment === service.environment &&
          r.errorPct !== null &&
          r.requestRate !== null,
      ),
      weight = parts.reduce((sum, r) => sum + r.requestRate!, 0);
    const selected = [...resources.values()].filter(
      (r) =>
        !r.retired &&
        r.service === service.name &&
        r.environment === service.environment &&
        metricsByResource.has(resourceKey(r)),
    );
    service.errorPct =
      selected.length === 1
        ? selected[0].errorPct
        : parts.length === selected.length && weight > 0
          ? parts.reduce((sum, r) => sum + r.errorPct! * r.requestRate!, 0) / weight
          : null;
  }
  const buckets = new Map<number, Metric[]>();
  const step = Math.max(30000, Math.ceil((scope.to - scope.from) / 120 / 1000) * 1000);
  for (const m of metrics.filter((m) =>
    ['request_rate', 'error_pct', 'latency_p95_ms', 'probe_up'].includes(m.name),
  )) {
    const t = Math.floor(m.timestamp / step) * step;
    const b = buckets.get(t) ?? [];
    b.push(m);
    buckets.set(t, b);
  }
  const series: Dashboard['series'] = {
    request_rate: { name: '요청량', unit: 'req/s', points: [] },
    error_pct: { name: '요청 가중 오류율', unit: '%', points: [] },
    latency_p95_ms: { name: '최대 인스턴스 p95', unit: 'ms', points: [] },
  };
  for (const [time, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const latest = new Map<string, Metric>();
    for (const r of rows)
      if (!latest.has(resourceKey(r) + '\0' + r.name))
        latest.set(resourceKey(r) + '\0' + r.name, r);
    const unique = [...latest.values()],
      rates = unique.filter((m) => m.name === 'request_rate'),
      sum = rates.reduce((n, m) => n + m.value, 0),
      errors = unique.filter((m) => m.name === 'error_pct'),
      latencies = unique.filter((m) => m.name === 'latency_p95_ms');
    if (rates.length) series.request_rate.points.push([time, sum]);
    for (const region of new Set(rates.map((m) => identity(m).region))) {
      const key = 'request_rate:region:' + region,
        item = series[key] ?? { name: region, unit: 'req/s', points: [] };
      item.points.push([
        time,
        rates.filter((m) => identity(m).region === region).reduce((sum, m) => sum + m.value, 0),
      ]);
      series[key] = item;
    }
    const pairs = errors
      .map((e) => ({
        e,
        r: rates.find((r) => resourceKey(r) === resourceKey(e))?.value,
      }))
      .filter((p) => p.r !== undefined);
    const weight = pairs.reduce((n, p) => n + p.r!, 0);
    if (weight > 0 && pairs.length === errors.length && pairs.length === rates.length)
      series.error_pct.points.push([
        time,
        pairs.reduce((n, p) => n + p.e.value * p.r!, 0) / weight,
      ]);
    if (latencies.length)
      series.latency_p95_ms.points.push([time, Math.max(...latencies.map((m) => m.value))]);
  }
  const hostBuckets = new Set<string>();
  for (const m of metrics.filter((m) => m.host && ['cpu_pct', 'memory_pct'].includes(m.name))) {
    const key = m.name + ':' + createHash('sha256').update(resourceKey(m)).digest('hex'),
      time = Math.floor(m.timestamp / step) * step,
      bucket = key + ':' + time;
    if (hostBuckets.has(bucket)) continue;
    hostBuckets.add(bucket);
    const item = series[key] ?? {
      name: m.host! + ' / ' + identity(m).region,
      unit: '%',
      points: [],
    };
    item.points.push([time, m.value]);
    series[key] = item;
  }
  for (const [key, item] of Object.entries(series))
    if (key.startsWith('cpu_pct:') || key.startsWith('memory_pct:'))
      item.points.sort((a, b) => a[0] - b[0]);
  const aiSpans = spans.filter((s) => s.ai),
    costs = aiSpans.filter((s) => s.ai?.costUsd !== undefined),
    durations = aiSpans.map((s) => s.durationMs).sort((a, b) => a - b),
    models = new Map<string, { name: string; calls: number; cost: number | null }>();
  for (const s of aiSpans) {
    const ai = s.ai!,
      name = ai.provider + '/' + ai.model,
      entry = models.get(name) ?? { name, calls: 0, cost: null };
    entry.calls++;
    if (ai.costUsd !== undefined) entry.cost = (entry.cost ?? 0) + ai.costUsd;
    models.set(name, entry);
  }
  const alertPage = await store.alertPage(scope);
  const match = (x: { service: string; environment: string }) =>
    [
      'service',
      'environment',
      'module',
      'region',
      'zone',
      'cluster',
      'namespace',
      'instanceId',
    ].every(
      (key) =>
        !scope[key as keyof QueryScope] ||
        !(key in x) ||
        x[key as keyof typeof x] === scope[key as keyof QueryScope],
    );
  return {
    resources: [...resources.values()],
    inventoryTruncated: !!inventoryPage?.truncated,
    services: [...serviceMap.values()].sort(
      (a, b) =>
        (b.status === 'degraded' ? 1 : 0) - (a.status === 'degraded' ? 1 : 0) ||
        a.name.localeCompare(b.name),
    ),
    hosts: [...hostMap.values()],
    series,
    logs,
    spans,
    alerts: alertPage.items,
    incidents: (await store.incidents(scope.workspace)).filter(match),
    rules: (await store.rules(scope.workspace)).filter((r) =>
      [
        'service',
        'environment',
        'module',
        'region',
        'zone',
        'cluster',
        'namespace',
        'instanceId',
      ].every(
        (key) =>
          !scope[key as keyof QueryScope] ||
          !r[key as keyof typeof r] ||
          r[key as keyof typeof r] === scope[key as keyof QueryScope],
      ),
    ),
    truncated:
      metricPage.truncated ||
      logPage.truncated ||
      spanPage.truncated ||
      latestPage.truncated ||
      !!inventoryPage?.truncated ||
      alertPage.truncated,
    window: { from: scope.from, to: scope.to },
    ai: {
      calls: aiSpans.length,
      inputTokens: aiSpans.reduce((n, s) => n + s.ai!.inputTokens, 0),
      outputTokens: aiSpans.reduce((n, s) => n + s.ai!.outputTokens, 0),
      reportedCost: costs.length ? costs.reduce((n, s) => n + s.ai!.costUsd!, 0) : null,
      costCoverage: aiSpans.length ? costs.length / aiSpans.length : 0,
      errorPct: aiSpans.length
        ? (100 * aiSpans.filter((s) => s.status === 'error').length) / aiSpans.length
        : null,
      p95: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
      models: [...models.values()],
      evaluations: aiSpans
        .filter((s) => s.ai?.evaluation)
        .map((s) => ({ ...s.ai!.evaluation!, traceId: s.traceId })),
    },
  };
}
export async function briefing(
  store: Storage,
  scope: QueryScope,
  telemetry: TelemetryStore = store,
) {
  const d = await dashboard(store, scope, telemetry),
    errors = d.logs.filter((l) => l.level === 'error'),
    slow = d.spans.filter((s) => s.status === 'error').sort((a, b) => b.durationMs - a.durationMs);
  return {
    mode: 'deterministic',
    generatedAt: Date.now(),
    headline: errors.length
      ? `${errors.length}개 오류 로그와 ${slow.length}개 실패 스팬이 현재 범위에 있습니다.`
      : '현재 범위에서 실패 근거가 발견되지 않았습니다. 수집 범위와 신선도를 함께 확인하세요.',
    facts: [
      ...d.alerts
        .filter((a) => a.status === 'firing')
        .map((a) => ({
          text: `${a.title}: ${a.reason === 'no_data' ? '최근 데이터 없음' : a.value}`,
          source: { kind: 'alert', id: a.id },
        })),
      ...errors
        .slice(0, 3)
        .map((l) => ({ text: l.message, source: { kind: 'log', id: l.id, traceId: l.traceId } })),
      ...slow.slice(0, 2).map((s) => ({
        text: `${s.name}: ${s.durationMs.toFixed(0)} ms, 실패`,
        source: { kind: 'trace', id: s.traceId },
      })),
    ],
    hypotheses: errors.some((l) => /pool|connection/i.test(l.message))
      ? ['DB 연결 풀 포화 가능성: 연결 수, acquire timeout, 배포 전후 변화와 DB 응답을 대조하세요.']
      : [],
    limitations: '규칙 기반 근거 요약입니다. 인과관계나 근본 원인을 확정하지 않습니다.',
    truncated: d.truncated,
  };
}
