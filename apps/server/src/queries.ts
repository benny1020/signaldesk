import type {
  Dashboard,
  QueryScope,
  Metric,
  Log,
  Span,
} from '../../../packages/contracts/src/index.ts';
import { Store, type TelemetryStore } from './store.ts';
export async function dashboard(
  store: Store,
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
  const serviceMap = new Map<string, Dashboard['services'][number]>(),
    hostMap = new Map<string, Dashboard['hosts'][number]>();
  const seen = new Set<string>();
  for (const m of metrics) {
    const signature = [m.service, m.environment, m.host ?? '', m.name].join('\0');
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (m.host) {
      const h = hostMap.get(m.host) ?? {
        name: m.host,
        cpu: null,
        memory: null,
        lastSeen: m.timestamp,
      };
      if (m.name === 'cpu_pct' && h.cpu === null) h.cpu = m.value;
      if (m.name === 'memory_pct' && h.memory === null) h.memory = m.value;
      hostMap.set(m.host, h);
      continue;
    }
    if (!['request_rate', 'error_pct', 'latency_p95_ms', 'probe_up'].includes(m.name)) continue;
    const key = m.service + '\0' + m.environment,
      s = serviceMap.get(key) ?? {
        name: m.service,
        environment: m.environment,
        requestRate: null,
        errorPct: null,
        latency: null,
        lastSeen: m.timestamp,
        status: 'unknown',
      };
    if (m.name === 'request_rate' && s.requestRate === null) s.requestRate = m.value;
    if (m.name === 'error_pct' && s.errorPct === null) s.errorPct = m.value;
    if (m.name === 'latency_p95_ms' && s.latency === null) s.latency = m.value;
    if (scope.to - s.lastSeen > 120000) s.status = 'unknown';
    else if ((s.errorPct ?? 0) > 1 || (m.name === 'probe_up' && m.value === 0))
      s.status = 'degraded';
    else if (s.status !== 'degraded') s.status = 'healthy';
    serviceMap.set(key, s);
  }
  const buckets = new Map<number, Metric[]>();
  const step = Math.max(30000, Math.ceil((scope.to - scope.from) / 120 / 1000) * 1000);
  for (const m of metrics.filter((m) => !m.host)) {
    const t = Math.floor(m.timestamp / step) * step;
    const b = buckets.get(t) ?? [];
    b.push(m);
    buckets.set(t, b);
  }
  const series: Dashboard['series'] = {
    request_rate: { name: '요청량', unit: 'req/s', points: [] },
    error_pct: { name: '요청 가중 오류율', unit: '%', points: [] },
    latency_p95_ms: { name: '최대 서비스 p95', unit: 'ms', points: [] },
  };
  for (const [time, rows] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const latest = new Map<string, Metric>();
    for (const r of rows)
      if (!latest.has(r.service + '\0' + r.environment + '\0' + r.name))
        latest.set(r.service + '\0' + r.environment + '\0' + r.name, r);
    const unique = [...latest.values()],
      rates = unique.filter((m) => m.name === 'request_rate'),
      sum = rates.reduce((n, m) => n + m.value, 0),
      errors = unique.filter((m) => m.name === 'error_pct'),
      latencies = unique.filter((m) => m.name === 'latency_p95_ms');
    if (rates.length) series.request_rate.points.push([time, sum]);
    const pairs = errors
      .map((e) => ({
        e,
        r: rates.find((r) => r.service === e.service && r.environment === e.environment)?.value,
      }))
      .filter((p) => p.r !== undefined);
    const weight = pairs.reduce((n, p) => n + p.r!, 0);
    if (weight > 0)
      series.error_pct.points.push([
        time,
        pairs.reduce((n, p) => n + p.e.value * p.r!, 0) / weight,
      ]);
    if (latencies.length)
      series.latency_p95_ms.points.push([time, Math.max(...latencies.map((m) => m.value))]);
  }
  const hostBuckets = new Set<string>();
  for (const m of metrics.filter((m) => m.host && ['cpu_pct', 'memory_pct'].includes(m.name))) {
    const key = m.name + ':' + m.host,
      time = Math.floor(m.timestamp / step) * step,
      bucket = key + ':' + time;
    if (hostBuckets.has(bucket)) continue;
    hostBuckets.add(bucket);
    const item = series[key] ?? { name: m.host!, unit: '%', points: [] };
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
  const match = (x: { service: string; environment: string }) =>
    (!scope.service || x.service === scope.service) &&
    (!scope.environment || x.environment === scope.environment);
  return {
    services: [...serviceMap.values()].sort(
      (a, b) =>
        (b.status === 'degraded' ? 1 : 0) - (a.status === 'degraded' ? 1 : 0) ||
        a.name.localeCompare(b.name),
    ),
    hosts: [...hostMap.values()],
    series,
    logs,
    spans,
    alerts: store.alerts(scope.workspace).filter(match),
    incidents: store.incidents(scope.workspace).filter(match),
    rules: store.rules(scope.workspace).filter(match),
    truncated: metricPage.truncated || logPage.truncated || spanPage.truncated,
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
export async function briefing(store: Store, scope: QueryScope, telemetry: TelemetryStore = store) {
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
