import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { dashboard } from './queries.ts';
import { Engine } from './engine.ts';
import { resourceKey, type Metric, type Rule } from '../../../packages/contracts/src/index.ts';
const time = Date.now(),
  key = randomBytes(32);
const metric = (
  region: string,
  instanceId: string,
  name: Metric['name'],
  value: number,
  timestamp = time,
  module = 'api',
): Metric => ({
  id: [region, instanceId, name, timestamp, module].join(':'),
  kind: 'metric',
  service: 'orders',
  environment: 'production',
  region,
  module,
  cluster: 'shared-name',
  namespace: 'commerce',
  instanceId,
  name,
  value,
  timestamp,
});
const rule = (patch: Partial<Rule> = {}): Rule => ({
  id: 'per-resource',
  workspace: 'live',
  name: 'Errors',
  service: 'orders',
  environment: 'production',
  metric: 'error_pct',
  operator: 'gt',
  threshold: 2,
  durationSec: 0,
  severity: 'critical',
  noData: 'alert',
  enabled: true,
  pendingSince: null,
  groupBy: 'resource',
  ...patch,
});
const scope = { workspace: 'live' as const, from: time - 60000, to: time };
test('compressed ingestion accepts Collector gzip and enforces the expanded body limit', async () => {
  const store = new Store(':memory:');
  const { app } = await createApp(store, { mode: 'local', tokens: [], key, allowedHosts: [] });
  try {
    const headers = { 'content-type': 'application/json', 'content-encoding': 'gzip' };
    const payload = { workspace: 'live', events: [metric('seoul', 'pod-1', 'error_pct', 1)] };
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers,
      payload: gzipSync(JSON.stringify(payload)),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().accepted, 1);
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      headers,
      payload: gzipSync(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) })),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(store.occupancy(), 1);
  } finally {
    await app.close();
    store.close();
  }
});
test('regions, modules and identically named replicas have independent identities and weighted sums', async () => {
  const store = new Store(':memory:');
  try {
    store.append('live', [
      metric('seoul', 'pod-1', 'request_rate', 90),
      metric('seoul', 'pod-1', 'error_pct', 1),
      metric('seoul', 'pod-1', 'latency_p95_ms', 100),
      metric('virginia', 'pod-1', 'request_rate', 10),
      metric('virginia', 'pod-1', 'error_pct', 20),
      metric('virginia', 'pod-1', 'latency_p95_ms', 1500),
    ]);
    const result = await dashboard(store, scope);
    assert.equal(result.services.length, 1);
    assert.equal(result.services[0].instances, 2);
    assert.equal(result.services[0].requestRate, 100);
    assert.equal(result.services[0].errorPct, 2.9);
    assert.equal(result.services[0].latency, 1500);
    assert.equal(result.resources.length, 2);
    assert.equal(result.series.request_rate.points[0][1], 100);
    assert.equal(result.series.error_pct.points[0][1], 2.9);
    assert.equal(result.series['request_rate:region:seoul'].points[0][1], 90);
    assert.equal(
      (await dashboard(store, { ...scope, region: 'seoul' })).services[0].requestRate,
      90,
    );
    store.append('live', [metric('seoul', 'pod-1', 'request_rate', 5, time, 'worker')]);
    assert.equal(store.inventory(scope).items.length, 3);
    assert.equal(
      store.query('metric', { ...scope, module: 'worker', region: 'seoul' }).items.length,
      1,
    );
  } finally {
    store.close();
  }
});
test('host labels do not discard API metrics and equal host names in different regions stay separate', async () => {
  const store = new Store(':memory:');
  try {
    store.append('live', [
      { ...metric('seoul', 'pod-1', 'request_rate', 40), host: 'node-1' },
      { ...metric('virginia', 'pod-1', 'request_rate', 30), host: 'node-1' },
      { ...metric('seoul', 'pod-1', 'cpu_pct', 20), host: 'node-1' },
      { ...metric('virginia', 'pod-1', 'cpu_pct', 80), host: 'node-1' },
    ]);
    const result = await dashboard(store, scope);
    assert.equal(result.services[0].requestRate, 70);
    assert.equal(result.hosts.length, 2);
    assert.notEqual(result.hosts[0].id, result.hosts[1].id);
    for (const host of result.hosts) assert.ok(result.series['cpu_pct:' + host.id]);
  } finally {
    store.close();
  }
});
test('duration, firing, recovery and no-data are maintained per replica; retirement is explicit', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, key);
  try {
    store.put('rule', rule({ durationSec: 10 }));
    store.append('live', [
      metric('seoul', 'pod-1', 'error_pct', 5),
      metric('virginia', 'pod-1', 'error_pct', 0),
    ]);
    await engine.evaluate('live', time);
    store.append('live', [metric('virginia', 'pod-1', 'error_pct', 7, time + 5000)]);
    await engine.evaluate('live', time + 5000);
    await engine.evaluate('live', time + 10000);
    assert.equal(store.alerts('live').filter((a) => a.status === 'firing').length, 1);
    assert.equal(store.alerts('live')[0].region, 'seoul');
    await engine.evaluate('live', time + 15000);
    assert.equal(store.alerts('live').filter((a) => a.status === 'firing').length, 2);
    store.append('live', [metric('seoul', 'pod-1', 'error_pct', 0, time + 16000)]);
    await engine.evaluate('live', time + 16000);
    assert.equal(store.alerts('live').filter((a) => a.status === 'firing').length, 1);
    assert.equal(store.alerts('live').find((a) => a.status === 'firing')?.region, 'virginia');
    await engine.evaluate('live', time + 150000);
    assert.equal(store.alerts('live').find((a) => a.status === 'firing')?.reason, 'no_data');
    const resource = store
      .inventory({ ...scope, to: time + 150000 })
      .items.find((r) => r.region === 'virginia')!;
    assert.ok(store.retireResource(resource.id, 'live', true));
    await engine.evaluate('live', time + 150001);
    assert.ok(!store.alerts('live').some((a) => a.region === 'virginia' && a.status === 'firing'));
    assert.ok(store.retireResource(resource.id, 'live', false));
    await engine.evaluate('live', time + 151000);
    assert.ok(!store.alerts('live').some((a) => a.region === 'virginia' && a.status === 'firing'));
    await engine.evaluate('live', time + 161000);
    assert.ok(store.alerts('live').some((a) => a.region === 'virginia' && a.status === 'firing'));
  } finally {
    store.close();
  }
});
test('regional aggregation uses all matching instances instead of the latest sample', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, key);
  try {
    store.put('rule', rule({ groupBy: 'region', metric: 'request_rate', threshold: 100 }));
    store.append('live', [
      metric('seoul', 'pod-1', 'request_rate', 60),
      metric('seoul', 'pod-2', 'request_rate', 60),
      metric('virginia', 'pod-1', 'request_rate', 50),
    ]);
    await engine.evaluate('live', time);
    const active = store.alerts('live').filter((a) => a.status === 'firing');
    assert.equal(active.length, 1);
    assert.equal(active[0].value, 120);
    assert.equal(active[0].region, 'seoul');
    assert.equal(active[0].instanceId, undefined);
  } finally {
    store.close();
  }
});
test('rule edits restart pending duration and dimension-scoped reads cannot leak logs', async () => {
  const store = new Store(':memory:'),
    result = await createApp(store, { mode: 'local', tokens: [], key, allowedHosts: [] });
  try {
    store.put('rule', rule({ durationSec: 20 }));
    store.append('live', [metric('seoul', 'pod-1', 'error_pct', 5)]);
    await result.engine.evaluate('live', time);
    const patch = await result.app.inject({
      method: 'PATCH',
      url: '/api/rules/per-resource?workspace=live',
      payload: { threshold: 3 },
    });
    assert.equal(patch.statusCode, 200);
    await result.engine.evaluate('live', time + 25000);
    assert.equal(store.alerts('live').length, 0);
    for (const region of ['seoul', 'virginia'])
      store.append('live', [
        {
          kind: 'log',
          id: region,
          timestamp: time,
          service: 'orders',
          environment: 'production',
          region,
          module: 'api',
          instanceId: 'pod-1',
          level: 'error',
          message: 'same message',
          attributes: {},
        },
      ]);
    const logs = (
      await result.app.inject('/api/logs?workspace=live&region=seoul&module=api&instanceId=pod-1')
    ).json();
    assert.equal(logs.items.length, 1);
    assert.equal(logs.items[0].region, 'seoul');
    assert.equal(
      (await result.app.inject('/api/resources?workspace=live&region=virginia')).json().items
        .length,
      1,
    );
  } finally {
    await result.app.close();
    store.close();
  }
});
test('OTLP resource attributes preserve deployment identity; exact traces cross region scope', async () => {
  const store = new Store(':memory:'),
    { app } = await createApp(store, { mode: 'local', tokens: [], key, allowedHosts: [] });
  try {
    const attributes = Object.entries({
      'service.name': 'orders',
      'service.instance.id': 'pod-1',
      'service.namespace': 'api',
      'cloud.region': 'seoul',
      'cloud.availability_zone': 'seoul-a',
      'k8s.cluster.name': 'prod',
      'k8s.namespace.name': 'commerce',
    }).map(([key, stringValue]) => ({ key, value: { stringValue } }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/traces',
      payload: {
        resourceSpans: [
          {
            resource: { attributes },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'cross-region',
                    spanId: 'a',
                    name: 'root',
                    startTimeUnixNano: String(BigInt(time) * 1000000n),
                    endTimeUnixNano: String(BigInt(time + 10) * 1000000n),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    store.append('live', [
      {
        kind: 'span',
        id: 'remote-child',
        timestamp: time,
        service: 'billing',
        environment: 'production',
        region: 'virginia',
        instanceId: 'pod-1',
        traceId: 'cross-region',
        spanId: 'b',
        parentSpanId: 'a',
        name: 'remote',
        durationMs: 5,
        status: 'ok',
        attributes: {},
      },
    ]);
    const page = (await app.inject('/api/traces/cross-region?workspace=live&region=seoul')).json();
    assert.equal(page.items.length, 2);
    const root = page.items.find((s: { spanId: string }) => s.spanId === 'a');
    assert.equal(root.module, 'api');
    assert.equal(root.cluster, 'prod');
    assert.equal(root.instanceId, 'pod-1');
    assert.notEqual(
      resourceKey(root),
      resourceKey(page.items.find((s: { spanId: string }) => s.spanId === 'b')),
    );
  } finally {
    await app.close();
    store.close();
  }
});

test('historical resource values survive newer reports and late events never move latest backwards', async () => {
  const store = new Store(':memory:');
  try {
    store.append('live', [
      metric('seoul', 'pod-1', 'error_pct', 2, time - 30000),
      metric('seoul', 'pod-1', 'error_pct', 9, time + 10000),
      metric('seoul', 'pod-1', 'error_pct', 3, time - 20000),
    ]);
    assert.equal(store.latestMetrics(scope).items[0].value, 3);
    assert.equal(store.latestMetrics({ ...scope, to: time + 10001 }).items[0].value, 9);
    assert.equal(store.inventory(scope).items.length, 1);
    assert.equal(store.inventory(scope).items[0].firstSeen, time - 30000);
  } finally {
    store.close();
  }
});

test('cardinality bounds roll back a batch without consuming events or merging resource identities', () => {
  const store = new Store(':memory:', 100, 1);
  try {
    const first = metric('seoul', 'pod-1', 'error_pct', 1);
    assert.equal(store.append('live', [first]), 1);
    assert.throws(() => store.append('live', [metric('virginia', 'pod-1', 'error_pct', 3)]));
    assert.equal(store.occupancy(), 1);
    assert.equal(store.inventory(scope).items.length, 1);
    assert.equal(store.append('live', [first]), 0);
  } finally {
    store.close();
  }
});

test('rule preview evaluates aggregate groups instead of comparing individual samples', async () => {
  const store = new Store(':memory:'),
    { app } = await createApp(store, { mode: 'local', tokens: [], key, allowedHosts: [] });
  try {
    store.append('live', [
      metric('seoul', 'pod-1', 'request_rate', 60),
      metric('seoul', 'pod-2', 'request_rate', 60),
      metric('virginia', 'pod-1', 'request_rate', 50),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/rules/preview?workspace=live',
      payload: {
        ...rule({ groupBy: 'region', metric: 'request_rate', threshold: 100 }),
        id: undefined,
        pendingSince: undefined,
        workspace: undefined,
      },
    });
    assert.equal(response.statusCode, 200);
    const preview = response.json();
    assert.equal(preview.samples, 3);
    assert.equal(preview.groupCount, 2);
    assert.equal(preview.violations, 1);
    assert.equal(preview.latest, 120);
  } finally {
    await app.close();
    store.close();
  }
});

test('strict production ingestion rejects missing identity atomically', async () => {
  const store = new Store(':memory:'),
    { app } = await createApp(store, {
      mode: 'local',
      tokens: [],
      key,
      allowedHosts: [],
      requireResourceIdentity: true,
    });
  try {
    const valid = metric('seoul', 'pod-1', 'error_pct', 1);
    const incomplete = { ...valid, id: 'missing-region', region: undefined };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ingest',
          payload: { workspace: 'live', events: [valid, incomplete] },
        })
      ).statusCode,
      400,
    );
    assert.equal(store.occupancy(), 0);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/ingest',
          payload: { workspace: 'live', events: [valid] },
        })
      ).json().accepted,
      1,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test('partial aggregate data honors ignore-no-data instead of alerting on incomplete values', async () => {
  const store = new Store(':memory:');
  const { app } = await createApp(store, { mode: 'local', tokens: [], key, allowedHosts: [] });
  try {
    const input = rule({ groupBy: 'service', noData: 'ignore' });
    store.put('rule', input);
    store.append('live', [
      metric('seoul', 'pod-1', 'error_pct', 9),
      metric('virginia', 'pod-1', 'request_rate', 10),
    ]);
    const engine = new Engine(store, key);
    await engine.evaluate('live', time);
    assert.equal(store.alerts('live').length, 0);
    const preview = (
      await app.inject({ method: 'POST', url: '/api/rules/preview?workspace=live', payload: input })
    ).json();
    assert.equal(preview.noDataGroups, 1);
    assert.equal(preview.violations, 0);
    const data = await dashboard(store, scope);
    assert.equal(data.resources.find((r) => r.region === 'virginia')?.status, 'unknown');
    assert.equal(data.series.error_pct.points.length, 0);
  } finally {
    await app.close();
    store.close();
  }
});
