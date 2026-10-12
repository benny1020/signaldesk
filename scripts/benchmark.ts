import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../apps/server/src/store.ts';
import { createApp } from '../apps/server/src/app.ts';
import { exampleRegions } from '../packages/contracts/src/deployments.ts';
import type { TelemetryEvent, RequestFlow, Span } from '../packages/contracts/src/index.ts';
// Isolated disk-backed fixture exercise; never opens an operator's existing database.
const dir = await mkdtemp(join(tmpdir(), 'signaldesk-benchmark-'));
const path = join(dir, 'fixture.sqlite'),
  total = 100000,
  now = Date.now();
let store = new Store(path),
  app: FastifyInstance | undefined;
try {
  const started = performance.now();
  for (let first = 0; first < total / 8; first += 125) {
    const rows: TelemetryEvent[] = [];
    for (let i = first; i < first + 125; i++) {
      const region = exampleRegions[i % 5].id,
        service = 'benchmark-orders-' + (Math.floor(i / 5) % 20);
      const timestamp = now - (i % 1000) * 3000,
        traceId = 'bench-' + i;
      const resource = {
        environment: 'benchmark',
        region,
        module: 'api',
        instanceId: 'pod-' + (Math.floor(i / 100) % 10),
      };
      const span = (patch: Partial<Span>): Span => ({
        kind: 'span',
        timestamp,
        traceId,
        service,
        ...resource,
        spanId: 'root',
        name: 'POST /orders',
        spanKind: 'server',
        durationMs: 230,
        status: 'ok',
        attributes: {
          'http.route': '/orders',
          'http.request.method': 'POST',
          'http.response.status_code': 200,
        },
        ...patch,
      });
      rows.push(
        span({ id: traceId + '-root', service: 'benchmark-gateway', module: 'edge' }),
        span({
          id: traceId + '-call',
          spanId: 'call',
          parentSpanId: 'root',
          spanKind: 'client',
          service: 'benchmark-gateway',
          module: 'edge',
          durationMs: 180,
          attributes: {
            'server.address': service,
            'url.template': '/orders',
            'http.request.method': 'POST',
          },
        }),
        span({
          id: traceId + '-receive',
          spanId: 'receive',
          parentSpanId: 'call',
          durationMs: 160,
        }),
        span({
          id: traceId + '-provider',
          spanId: 'provider',
          parentSpanId: 'receive',
          spanKind: 'client',
          durationMs: i % 29 === 0 ? 600 : 80,
          status: i % 29 === 0 ? 'error' : 'ok',
          attributes: {
            'server.address': 'benchmark-provider.test',
            'url.template': '/authorize',
            'http.request.method': 'POST',
            'http.response.status_code': i % 29 === 0 ? 503 : 200,
          },
        }),
        ...(['request_rate', 'error_pct', 'latency_p95_ms'] as const).map((name) => ({
          kind: 'metric' as const,
          id: traceId + '-' + name,
          timestamp,
          service,
          ...resource,
          name,
          value: name === 'request_rate' ? 30 : name === 'error_pct' ? 0.2 : 160,
        })),
        {
          kind: 'log',
          id: traceId + '-log',
          timestamp,
          service,
          ...resource,
          traceId,
          level: 'info',
          message: 'Synthetic benchmark request',
          attributes: {},
        },
      );
    }
    assert.equal(await store.append('live', rows), rows.length);
  }
  const ingestionMs = performance.now() - started;
  store.close();
  store = new Store(path);
  assert.equal(store.occupancy(), total, 'fixture survives close and reopen');
  ({ app } = await createApp(store, {
    mode: 'local',
    tokens: [],
    key: randomBytes(32),
    allowedHosts: [],
  }));
  const measures: Record<string, { medianMs: number; p95Ms: number; samples: number }> = {};
  for (const [name, route] of [
    ['dashboard', '/api/dashboard'],
    ['all-region-flow', '/api/request-flow'],
    ['seoul-flow', '/api/request-flow'],
  ]) {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = performance.now();
      const response: InjectResponse = await app.inject(
        route +
          `?workspace=live&from=${now - 3600000}&to=${now}` +
          (name === 'seoul-flow' ? '&region=ap-northeast-2' : ''),
      );
      assert.equal(response.statusCode, 200);
      if (name !== 'dashboard') {
        const data: RequestFlow = response.json();
        assert.equal(data.truncated, false);
        assert.equal(
          data.edges.reduce((n, e) => n + e.count, 0),
          ((total / 8) * 3) / (name === 'seoul-flow' ? 5 : 1),
        );
        if (name === 'seoul-flow')
          assert.ok(
            data.nodes
              .filter((n) => n.type === 'workload')
              .every((n) => n.region === 'ap-northeast-2'),
          );
      }
      samples.push(performance.now() - before);
    }
    samples.sort((a, b) => a - b);
    measures[name] = {
      medianMs: +samples[2].toFixed(2),
      p95Ms: +samples[4].toFixed(2),
      samples: samples.length,
    };
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        logicalCPUs: availableParallelism(),
        storage: 'temporary disk-backed SQLite WAL',
        fixtureEvents: total,
        regions: 5,
        orderServicesPerRegion: 20,
        instancesPerOrderService: 10,
        ingestionMs: Math.round(ingestionMs),
        databaseMiB: +((await stat(path)).size / 1048576).toFixed(1),
        rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
        queryMeasures: measures,
        persistedAfterReopen: true,
        regionalCountsAsserted: true,
        productionLoadCertification: false,
        limitations:
          'Sequential fixture append and HTTP handler queries on one machine. No concurrent producers, network ingress, PostgreSQL/WAN, retention churn or HA certification.',
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  store.close();
  await rm(dir, { recursive: true, force: true });
}
