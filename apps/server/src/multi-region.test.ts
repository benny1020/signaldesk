import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';
import { dashboard } from './queries.ts';
import { requestFlow } from './flow.ts';
import { Engine } from './engine.ts';
import {
  exampleRegions,
  regionalComparison,
  regionalSummary,
} from '../../../packages/contracts/src/deployments.ts';
import type { ResourceSummary, Metric, Rule } from '../../../packages/contracts/src/index.ts';

const now = Date.now();
const scope = { workspace: 'demo' as const, from: now - 3600000, to: now };

test('five-region demo keeps the same services on independent infrastructure with no inter-region calls', async () => {
  const store = new Store(':memory:');
  try {
    await seedDemo(store, now);
    const result = await dashboard(store, scope);
    const grid = regionalComparison(result.resources);
    assert.deepEqual([...grid.regions].sort(), exampleRegions.map((r) => r.id).sort());
    for (const row of grid.rows) assert.ok(row.cells.every((cell) => cell.instances === 2));
    const checkout = grid.rows.find((r) => r.service === 'checkout-api')!;
    assert.equal(checkout.cells.find((c) => c.region === 'ap-northeast-2')?.status, 'degraded');
    assert.ok(
      checkout.cells
        .filter((c) => c.region !== 'ap-northeast-2')
        .every((c) => c.status === 'healthy'),
    );
    const flow = await requestFlow(store, store, scope);
    const internal = flow.edges.filter(
      (e) =>
        e.direction === 'outbound' &&
        flow.nodes.find((n) => n.id === e.target)?.type === 'workload',
    );
    const node = (id: string) => flow.nodes.find((n) => n.id === id);
    assert.ok(internal.length > 0, 'same-region internal calls remain investigable');
    for (const edge of internal) {
      assert.equal(node(edge.source)?.region, node(edge.target)?.region);
      assert.ok(exampleRegions.some((r) => r.id === node(edge.source)?.region));
    }
    // Check every seeded span and log, including the older non-HTTP waterfall fixtures.
    const traces = new Map<string, Set<string>>();
    for (const kind of ['span', 'log'] as const) {
      const events = store.query(kind, { ...scope, limit: 10000 });
      assert.equal(events.nextCursor, null);
      for (const event of events.items) {
        if (event.kind === 'metric' || !event.traceId) continue;
        const regions = traces.get(event.traceId) ?? new Set<string>();
        regions.add(event.region!);
        traces.set(event.traceId, regions);
      }
    }
    assert.ok(traces.size >= 380);
    for (const regions of traces.values()) assert.equal(regions.size, 1);
    assert.deepEqual(
      [...new Set(flow.nodes.filter((n) => n.type === 'workload').map((n) => n.region))].sort(),
      grid.regions,
    );
    assert.equal(store.inventory({ ...scope, workspace: 'live' }).items.length, 0);
  } finally {
    store.close();
  }
});

const resource = (patch: Partial<ResourceSummary>): ResourceSummary => ({
  id: JSON.stringify(patch),
  service: 'orders',
  environment: 'production',
  module: 'api',
  region: 'seoul',
  zone: 'a',
  cluster: 'prod',
  namespace: 'orders',
  instanceId: 'pod-1',
  firstSeen: now,
  lastSeen: now,
  retired: false,
  status: 'healthy',
  requestRate: 90,
  errorPct: 1,
  latency: 100,
  ...patch,
});

test('geographic summaries preserve unknown locations, stale data and incomplete application totals', () => {
  const summaries = regionalSummary([
    resource({ region: 'ap-northeast-2', status: 'degraded' }),
    resource({
      region: 'ap-northeast-2',
      instanceId: 'pod-2',
      requestRate: 10,
      errorPct: 20,
      latency: 800,
    }),
    resource({
      region: 'custom-eu',
      status: 'unknown',
      requestRate: null,
      errorPct: null,
      latency: null,
    }),
    resource({ region: 'custom-eu', instanceId: 'pod-3' }),
    resource({ region: 'retired-region', retired: true }),
    resource({
      region: 'ap-northeast-2',
      service: 'infrastructure',
      host: 'node-1',
      requestRate: null,
      errorPct: null,
      latency: null,
    }),
  ]);
  assert.equal(summaries.length, 2);
  const seoul = summaries.find((r) => r.region === 'ap-northeast-2')!;
  assert.equal(seoul.location?.label, '서울');
  assert.equal(seoul.resources, 3);
  assert.equal(seoul.applications, 2);
  assert.equal(seoul.hosts, 1);
  assert.equal(seoul.services, 1);
  assert.equal(seoul.status, 'degraded');
  assert.equal(seoul.rate, 100);
  assert.equal(seoul.error, 2.9);
  assert.equal(seoul.latency, 800);
  const custom = summaries.find((r) => r.region === 'custom-eu')!;
  assert.equal(
    custom.location,
    undefined,
    'unregistered codes must not acquire an inferred location',
  );
  assert.equal(custom.status, 'unknown');
  assert.equal(custom.unknown, 1);
  assert.equal(custom.rate, null);
  assert.equal(custom.error, null);
  assert.deepEqual(regionalSummary([]), []);
});

test('geographic inventory summaries do not inherit the comparison grid caps', () => {
  const inputs = Array.from({ length: 60 }, (_, i) =>
    resource({ service: `service-${i}`, region: `custom-${i}` }),
  );
  const summaries = regionalSummary(inputs);
  assert.equal(summaries.length, 60);
  assert.equal(
    summaries.reduce((sum, r) => sum + r.resources, 0),
    inputs.length,
  );
  assert.equal(regionalComparison(inputs).regions.length, 12);
});

test('regional comparison preserves environment/module scope and never treats absent or partial telemetry as healthy totals', () => {
  const grid = regionalComparison([
    resource({}),
    resource({ instanceId: 'pod-2', requestRate: 10, errorPct: 20, latency: 1500 }),
    resource({
      region: 'japan',
      status: 'unknown',
      requestRate: null,
      errorPct: null,
      latency: null,
    }),
    resource({ module: 'worker', region: 'seoul', requestRate: 4 }),
    resource({ environment: 'staging', region: 'japan', requestRate: 5 }),
    resource({
      service: 'infrastructure',
      region: 'europe',
      host: 'node-1',
      observedApplication: false,
      requestRate: null,
      errorPct: null,
      latency: null,
    }),
    resource({ region: 'retired-only', retired: true }),
  ]);
  assert.equal(grid.rows.length, 3);
  assert.ok(!grid.regions.includes('retired-only'));
  const api = grid.rows.find((r) => r.environment === 'production' && r.module === 'api')!;
  const seoul = api.cells.find((c) => c.region === 'seoul')!;
  assert.equal(seoul.rate, 100);
  assert.equal(seoul.error, 2.9);
  assert.equal(seoul.latency, 1500);
  assert.equal(api.cells.find((c) => c.region === 'japan')?.status, 'unknown');
  assert.equal(api.cells.find((c) => c.region === 'europe')?.status, 'unobserved');
  const partial = regionalComparison([
    resource({}),
    resource({ instanceId: 'pod-2', status: 'unknown', requestRate: null, errorPct: null }),
  ]).rows[0].cells[0];
  assert.equal(partial.rate, null);
  assert.equal(partial.error, null);
  assert.equal(partial.status, 'unknown');
});

test('same-shaped five regional deployments evaluate failures and recovery independently', async () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, Buffer.alloc(32));
  const rule: Rule = {
    id: 'regional-errors',
    workspace: 'live',
    name: 'Regional errors',
    service: 'orders',
    environment: 'production',
    module: 'api',
    groupBy: 'region',
    metric: 'error_pct',
    operator: 'gt',
    threshold: 2,
    durationSec: 0,
    severity: 'critical',
    noData: 'alert',
    enabled: true,
    pendingSince: null,
  };
  const metrics: Metric[] = exampleRegions.flatMap((r) => [
    {
      kind: 'metric',
      id: r.id + ':errors',
      timestamp: now,
      service: 'orders',
      environment: 'production',
      module: 'api',
      region: r.id,
      cluster: 'same-name',
      namespace: 'orders',
      instanceId: 'same-name',
      name: 'error_pct',
      value: r.id === 'ap-northeast-2' ? 8 : 0,
    },
    {
      kind: 'metric',
      id: r.id + ':rate',
      timestamp: now,
      service: 'orders',
      environment: 'production',
      module: 'api',
      region: r.id,
      cluster: 'same-name',
      namespace: 'orders',
      instanceId: 'same-name',
      name: 'request_rate',
      value: 10,
    },
  ]);
  try {
    store.put('rule', rule);
    store.append('live', metrics);
    assert.equal(store.inventory({ ...scope, workspace: 'live' }).items.length, 5);
    await engine.evaluate('live', now);
    const firing = store.alerts('live').filter((a) => a.status === 'firing');
    assert.equal(firing.length, 1);
    assert.equal(firing[0].region, 'ap-northeast-2');
    store.append('live', [
      {
        ...metrics.find((m) => m.id === 'ap-northeast-2:errors')!,
        id: 'recovered',
        timestamp: now + 1000,
        value: 0,
      },
    ]);
    await engine.evaluate('live', now + 1000);
    assert.equal(store.alerts('live').filter((a) => a.status === 'firing').length, 0);
    assert.equal(store.alerts('live')[0].status, 'resolved');
  } finally {
    store.close();
  }
});

test('large regional inventories disclose a bounded comparison instead of creating an unbounded matrix', () => {
  const grid = regionalComparison(
    Array.from({ length: 100 }, (_, i) =>
      resource({ service: `service-${i}`, region: `region-${i}` }),
    ),
  );
  assert.equal(grid.totalRegions, 100);
  assert.equal(grid.totalServices, 100);
  assert.equal(grid.truncated, true);
  assert.equal(grid.rows.length, 50);
  assert.equal(grid.regions.length, 12);
  assert.ok(grid.rows.every((row) => row.cells.length === 12));
});
