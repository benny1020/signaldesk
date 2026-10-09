import type { Storage } from './storage.ts';
import { resourceKey } from '../../../packages/contracts/src/index.ts';
import type {
  TelemetryEvent,
  Rule,
  Alert,
  Incident,
} from '../../../packages/contracts/src/index.ts';
export async function seedDemo(store: Storage, now = Date.now()) {
  if (await store.setting('demoNow')) return;
  const services = [
    'api-gateway',
    'checkout-api',
    'payment-worker',
    'catalog-api',
    'auth-service',
    'ai-assistant',
  ];
  const events: TelemetryEvent[] = [];
  for (let i = 0; i < 64; i++) {
    const timestamp = now - (63 - i) * 45000;
    for (let j = 0; j < services.length; j++) {
      const service = services[j],
        incident = j === 1 && i > 43;
      const rates = [240, 83, 41, 126, 67, 12],
        rate = rates[j] * (0.9 + 0.13 * Math.sin(i * 0.3 + j));
      for (const [name, value] of [
        ['request_rate', rate],
        [
          'error_pct',
          incident ? 2.7 + Math.sin(i * 0.4) * 0.8 : 0.08 + Math.abs(Math.sin(i + j)) * 0.12,
        ],
        [
          'latency_p95_ms',
          incident
            ? 640 + Math.sin(i * 0.6) * 100
            : [78, 182, 134, 62, 48, 1230][j] * (0.9 + 0.1 * Math.cos(i * 0.2)),
        ],
      ] as const)
        events.push({
          id: `demo-${j}-${i}-${name}`,
          kind: 'metric',
          timestamp,
          service,
          environment: 'production',
          name,
          value,
        });
    }
    for (let j = 0; j < 3; j++)
      for (const [name, value] of [
        ['cpu_pct', j === 1 && i > 43 ? 78 + Math.sin(i) * 6 : 28 + j * 12 + Math.sin(i * 0.3) * 8],
        ['memory_pct', 46 + j * 11 + Math.sin(i * 0.1) * 2],
      ] as const)
        events.push({
          id: `host-${j}-${i}-${name}`,
          kind: 'metric',
          timestamp,
          service: 'infrastructure',
          environment: 'production',
          host: `node-prod-0${j + 1}`,
          name,
          value,
        });
  }
  for (let i = 0; i < 230; i++) {
    const service = services[i % 6],
      timestamp = now - i * 11000,
      traceId = `trace-${String(i).padStart(6, '0')}`,
      error = i % 6 === 1 && i < 80;
    events.push({
      id: `log-${i}`,
      kind: 'log',
      timestamp,
      service,
      environment: 'production',
      level: error ? 'error' : i % 9 === 0 ? 'warn' : 'info',
      message: error
        ? 'Database connection pool exhausted: acquire timeout after 5000 ms'
        : i % 9 === 0
          ? 'Upstream retry scheduled after transient response'
          : 'Request completed successfully',
      traceId,
      attributes: {
        'http.route': service === 'checkout-api' ? '/v1/checkout' : '/v1/' + service.split('-')[0],
        'http.status_code': error ? 503 : 200,
        'deployment.version': service === 'checkout-api' ? 'v2.18.0' : 'v1.42.1',
      },
    });
    const dur = error ? 710 : 110 + (i % 9) * 24;
    events.push({
      id: `span-${i}-root`,
      kind: 'span',
      timestamp,
      service,
      environment: 'production',
      traceId,
      spanId: `root-${i}`,
      name:
        service === 'ai-assistant' ? 'chat completion' : 'HTTP POST /v1/' + service.split('-')[0],
      durationMs: service === 'ai-assistant' ? 1500 + i * 5 : dur,
      status: error ? 'error' : 'ok',
      attributes: { 'http.status_code': error ? 503 : 200 },
      ...(service === 'ai-assistant'
        ? {
            ai: {
              provider: 'example-provider',
              model: Math.floor(i / 6) % 2 ? 'reasoning-large' : 'fast-small',
              inputTokens: 820 + i * 2,
              outputTokens: 240 + i,
              costUsd: 0.001 + (i % 9) * 0.0004,
              costSource: 'demo rate card · fixture v1',
              ttftMs: 220 + i,
              evaluation:
                Math.floor(i / 6) % 3 === 0
                  ? {
                      name: 'groundedness',
                      score: 0.88 - (i % 5) * 0.03,
                      source: 'rule' as const,
                      evaluator: 'demo-evaluator-v1',
                    }
                  : undefined,
            },
          }
        : {}),
    });
    if (service !== 'ai-assistant')
      for (let k = 0; k < 3; k++)
        events.push({
          id: `span-${i}-${k}`,
          kind: 'span',
          timestamp: timestamp + 8 + k * 15,
          service: k === 2 ? 'payment-worker' : service,
          environment: 'production',
          traceId,
          spanId: `child-${i}-${k}`,
          parentSpanId: `root-${i}`,
          name: ['auth.validate', 'db.query orders', 'payment.authorize'][k],
          durationMs: k === 1 && error ? 640 : 18 + k * 13,
          status: k === 1 && error ? 'error' : 'ok',
          attributes: { 'db.system': k === 1 ? 'postgresql' : '' },
        });
  }
  const regions = ['ap-northeast-2', 'us-east-1', 'eu-west-1'];
  const resource = (service: string, region: string, replica: number) => ({
    module: (
      {
        'api-gateway': 'edge',
        'checkout-api': 'checkout',
        'payment-worker': 'payments',
        'catalog-api': 'catalog',
        'auth-service': 'identity',
        'ai-assistant': 'assistant',
        infrastructure: 'platform',
      } as Record<string, string>
    )[service],
    region,
    zone: region + (replica === 0 ? 'a' : 'b'),
    cluster: 'prod-' + region,
    namespace: service === 'ai-assistant' ? 'ai' : 'commerce',
    instanceId: service + '-' + (replica + 1),
  });
  const expanded: TelemetryEvent[] = [];
  for (const e of events) {
    if (e.kind === 'metric')
      for (const [index, region] of regions.entries())
        for (let replica = 0; replica < (e.host ? 1 : 2); replica++) {
          const r = {
              ...resource(e.service, region, replica),
              ...(e.host ? { instanceId: e.host } : {}),
            },
            unhealthy =
              e.service === 'checkout-api' &&
              index === 0 &&
              replica === 0 &&
              e.timestamp > now - 15 * 60000;
          expanded.push({
            ...e,
            ...r,
            id: e.id + '-' + index + '-' + replica,
            value:
              e.name === 'request_rate'
                ? e.value * [0.5, 0.3, 0.2][index]
                : e.name === 'error_pct' && !unhealthy
                  ? 0.12
                  : e.name === 'latency_p95_ms' && e.service === 'checkout-api' && !unhealthy
                    ? 180
                    : e.value,
          });
        }
    else {
      const index = Number(e.traceId?.match(/\d+$/)?.[0] ?? 0),
        sourceRegion = Math.floor(index / 6) % 3,
        region =
          regions[
            e.kind === 'span' && e.name === 'payment.authorize'
              ? (sourceRegion + 1) % 3
              : sourceRegion
          ],
        replica = Math.floor(index / 18) % 2;
      expanded.push({ ...e, ...resource(e.service, region, replica) });
    }
  }
  await store.append('demo', expanded);
  const rule: Rule = {
    id: 'demo-checkout-rule',
    workspace: 'demo',
    name: 'Checkout 오류율 상승',
    service: 'checkout-api',
    environment: 'production',
    metric: 'error_pct',
    operator: 'gt',
    threshold: 2,
    durationSec: 60,
    severity: 'critical',
    noData: 'alert',
    enabled: true,
    pendingSince: now - 840000,
    groupBy: 'resource',
    module: 'checkout',
  };
  await store.put('rule', rule);
  const alert: Alert = {
    id: 'demo-alert-01',
    workspace: 'demo',
    ruleId: rule.id,
    title: rule.name,
    ...resource('checkout-api', 'ap-northeast-2', 0),
    groupKey: resourceKey({
      service: rule.service,
      environment: rule.environment,
      ...resource('checkout-api', 'ap-northeast-2', 0),
    }),
    service: rule.service,
    environment: rule.environment,
    severity: 'critical',
    status: 'firing',
    reason: 'threshold',
    value: 2.9,
    createdAt: now - 840000,
    resolvedAt: null,
    acknowledged: false,
    snoozedUntil: 0,
  };
  await store.put('alert', alert);
  const incident: Incident = {
    id: 'demo-incident-01',
    workspace: 'demo',
    title: 'Checkout 응답 지연 및 오류 증가',
    ...resource('checkout-api', 'ap-northeast-2', 0),
    service: 'checkout-api',
    environment: 'production',
    severity: 'critical',
    status: 'investigating',
    owner: 'Platform team',
    alertId: alert.id,
    createdAt: now - 780000,
    updatedAt: now - 300000,
    timeline: [
      { id: 't1', time: now - 900000, text: '배포 v2.18.0 — 예제 변경 이벤트', actor: 'demo' },
      {
        id: 't2',
        time: now - 840000,
        text: '오류율 임계치 2% 초과, 알림 발생',
        actor: 'rule engine',
      },
      {
        id: 't3',
        time: now - 780000,
        text: '장애 등록, DB 연결 풀 조사 시작',
        actor: 'Platform team',
      },
    ],
  };
  await store.put('incident', incident);
  await store.setSetting('demoNow', String(now));
  await store.setSetting('demoRevision', '2');
}
