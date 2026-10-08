import { Store } from '../apps/server/src/store.ts';
import { dashboard } from '../apps/server/src/queries.ts';
import type { TelemetryEvent } from '../packages/contracts/src/index.ts';
const store = new Store(':memory:'),
  now = Date.now(),
  total = 100000,
  start = performance.now();
for (let batch = 0; batch < total; batch += 1000) {
  const rows: TelemetryEvent[] = [];
  for (let i = batch; i < batch + 1000; i++) {
    const timestamp = now - Math.floor(i / 100) * 30000,
      service = 'service-' + (i % 20),
      environment = 'production';
    if (i % 10 < 6)
      rows.push({
        id: 'e' + i,
        kind: 'metric',
        timestamp,
        service,
        environment,
        name: i % 3 === 0 ? 'request_rate' : i % 3 === 1 ? 'error_pct' : 'latency_p95_ms',
        value: i % 3 === 1 ? 0.2 : i % 3 === 0 ? 30 : 160,
      });
    else if (i % 10 < 9)
      rows.push({
        id: 'e' + i,
        kind: 'log',
        timestamp,
        service,
        environment,
        level: 'info',
        message: 'Fixture request completed',
        attributes: {},
      });
    else
      rows.push({
        id: 'e' + i,
        kind: 'span',
        timestamp,
        service,
        environment,
        traceId: 'trace-' + i,
        spanId: 'span-' + i,
        name: 'GET /fixture',
        durationMs: 160,
        status: 'ok',
        attributes: {},
      });
  }
  store.append('live', rows);
}
const ingestionMs = performance.now() - start,
  durations: number[] = [];
for (let i = 0; i < 20; i++) {
  const before = performance.now();
  await dashboard(store, { workspace: 'live', from: now - 24 * 3600000, to: now });
  durations.push(performance.now() - before);
}
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      storage: 'in-memory SQLite',
      fixtureEvents: total,
      ingestionMs: Math.round(ingestionMs),
      dashboardIterations: durations.length,
      dashboardMedianMs: +durations[10].toFixed(2),
      dashboardP95Ms: +durations[18].toFixed(2),
      queryCaps: { metrics: 10000, logs: 300, spans: 1000 },
      productionLoadCertification: false,
    },
    null,
    2,
  ),
);
store.close();
