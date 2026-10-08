import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { Engine, type Channel, type Probe } from './engine.ts';
import { encrypt, publicAddress } from './network.ts';
import type { TelemetryStore } from './store.ts';
import { dashboard } from './queries.ts';
import type { Rule, Metric } from '../../../packages/contracts/src/index.ts';
const now = Date.now(),
  key = randomBytes(32);
const metric = (value: number, time = now): Metric => ({
  id: 'm-' + time + '-' + value,
  kind: 'metric',
  timestamp: time,
  service: 'orders',
  environment: 'production',
  name: 'error_pct',
  value,
});
const rule = (patch: Partial<Rule> = {}): Rule => ({
  id: 'rule1',
  workspace: 'live',
  name: 'Orders error',
  service: 'orders',
  environment: 'production',
  metric: 'error_pct',
  operator: 'gt',
  threshold: 2,
  durationSec: 10,
  severity: 'critical',
  noData: 'alert',
  enabled: true,
  pendingSince: null,
  ...patch,
});
async function setup(mode: 'local' | 'token' = 'local') {
  const store = new Store(':memory:');
  const result = await createApp(store, {
    mode,
    key,
    tokens: [
      { token: 'a'.repeat(32), role: 'admin', workspaces: ['live'], name: 'admin' },
      { token: 'v'.repeat(32), role: 'viewer', workspaces: ['live'], name: 'viewer' },
      { token: 'i'.repeat(32), role: 'ingest', workspaces: ['live'], name: 'producer' },
    ],
    allowedHosts: [],
  });
  return {
    ...result,
    store,
    close: async () => {
      await result.app.close();
      store.close();
    },
  };
}
test('batch is atomic, idempotent and sanitizes sensitive content', async () => {
  const s = await setup();
  try {
    const log = {
      kind: 'log',
      id: 'l1',
      timestamp: now,
      service: 'orders',
      environment: 'production',
      level: 'error',
      message: 'authorization=abc Bearer abc.123',
      attributes: { password: 'secret', normal: 'ok' },
    };
    const invalid = await s.app.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: { workspace: 'live', events: [metric(3), { ...log, level: 'bad' }] },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(s.store.occupancy(), 0);
    for (let i = 0; i < 2; i++) {
      const r = await s.app.inject({
        method: 'POST',
        url: '/api/ingest',
        payload: { workspace: 'live', events: [metric(3), log] },
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().accepted, i ? 0 : 2);
    }
    const stored = s.store.query('log', { workspace: 'live', from: now - 1, to: now + 1 }).items[0];
    assert.equal(stored.kind, 'log');
    assert.ok(!JSON.stringify(stored).includes('abc'));
    assert.ok(!JSON.stringify(stored).includes('secret'));
  } finally {
    await s.close();
  }
});
test('role and workspace enforcement blocks read/write leakage', async () => {
  const s = await setup('token');
  try {
    assert.equal((await s.app.inject('/api/dashboard?workspace=live')).statusCode, 401);
    assert.equal(
      (
        await s.app.inject({
          url: '/api/dashboard?workspace=demo',
          headers: { authorization: 'Bearer ' + 'a'.repeat(32) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/rules?workspace=live',
          headers: { authorization: 'Bearer ' + 'v'.repeat(32) },
          payload: rule(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          url: '/api/logs?workspace=live',
          headers: { authorization: 'Bearer ' + 'i'.repeat(32) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/ingest',
          headers: { authorization: 'Bearer ' + 'i'.repeat(32) },
          payload: { workspace: 'demo', events: [metric(1)] },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await s.app.inject({
          url: '/api/dashboard?workspace=live',
          headers: { authorization: 'Bearer ' + 'v'.repeat(32) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await s.close();
  }
});
test('duration, single firing alert, recovery and no-data are distinct', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, key);
  store.put('rule', rule());
  store.append('live', [metric(4)]);
  await engine.evaluate('live', now);
  assert.equal(store.alerts('live').length, 0);
  await engine.evaluate('live', now + 10001);
  assert.equal(store.alerts('live').length, 1);
  await engine.evaluate('live', now + 11000);
  assert.equal(store.alerts('live').length, 1);
  store.append('live', [metric(0, now + 12000)]);
  await engine.evaluate('live', now + 12001);
  assert.equal(store.alerts('live')[0].status, 'resolved');
  await engine.evaluate('live', now + 150000);
  await engine.evaluate('live', now + 160001);
  assert.equal(store.alerts('live')[0].reason, 'no_data');
  store.close();
});
test('outbox retries, snooze and delivery do not change acknowledgement', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const engine = new Engine(store, key, async () => {
    calls++;
    return { status: calls === 1 ? 503 : 204, durationMs: 2 };
  });
  store.put('rule', rule({ durationSec: 0 }));
  const c: Channel = {
    id: 'c',
    workspace: 'live',
    name: 'test',
    encryptedUrl: encrypt('https://example.com/hook', key),
    enabled: true,
    createdAt: now,
  };
  store.put('channel', c);
  store.append('live', [metric(4)]);
  await engine.evaluate('live', now);
  const alert = store.alerts('live')[0];
  alert.snoozedUntil = now + 1000;
  store.put('alert', alert);
  await engine.deliver(now);
  assert.equal(calls, 0);
  await engine.deliver(now + 1001);
  assert.equal(calls, 1);
  assert.equal(
    (store.db.prepare('SELECT status FROM outbox').get() as { status: string }).status,
    'pending',
  );
  await engine.deliver(now + 20000);
  assert.equal(calls, 2);
  assert.equal(
    (store.db.prepare('SELECT status FROM outbox').get() as { status: string }).status,
    'delivered',
  );
  assert.equal(store.alerts('live')[0].acknowledged, false);
  store.close();
});
test('keyset pagination handles identical timestamps and search is scoped', () => {
  const store = new Store(':memory:');
  store.append(
    'live',
    Array.from({ length: 11 }, (_, i) => ({
      kind: 'log',
      id: String(i).padStart(3, '0'),
      timestamp: now,
      service: 'orders',
      environment: 'production',
      level: 'info',
      message: 'same ' + i,
      attributes: {},
    })),
  );
  const first = store.query('log', { workspace: 'live', from: now, to: now, limit: 5 }),
    second = store.query('log', {
      workspace: 'live',
      from: now,
      to: now,
      limit: 5,
      cursor: first.nextCursor!,
    });
  assert.equal(first.items.length, 5);
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 10);
  assert.equal(store.query('log', { workspace: 'demo', from: now, to: now }).items.length, 0);
  store.close();
});
test('persistence survives reopen, workspace entities cannot cross-read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signaldesk-')),
    path = join(dir, 'db.sqlite');
  let store = new Store(path);
  store.put('rule', rule());
  store.append('live', [metric(4)]);
  store.close();
  store = new Store(path);
  assert.equal(store.rules('live').length, 1);
  assert.equal(store.rules('demo').length, 0);
  assert.equal(store.occupancy(), 1);
  store.close();
  rmSync(dir, { recursive: true });
});
test('AI cost requires provenance and prompt bodies are stripped', async () => {
  const s = await setup();
  try {
    const span = {
      kind: 'span',
      id: 'ai1',
      timestamp: now,
      service: 'ai',
      traceId: 't1',
      spanId: 's1',
      name: 'chat',
      durationMs: 30,
      status: 'ok',
      attributes: { 'gen_ai.input.messages': 'sensitive prompt' },
      ai: { provider: 'example', model: 'example', inputTokens: 2, outputTokens: 3, costUsd: 0.01 },
    };
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/ingest',
          payload: { workspace: 'live', events: [span] },
        })
      ).statusCode,
      400,
    );
    span.ai = Object.assign(span.ai, { costSource: 'manual card v1' });
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/ingest',
          payload: { workspace: 'live', events: [span] },
        })
      ).statusCode,
      200,
    );
    assert.ok(
      !JSON.stringify(s.store.query('span', { workspace: 'live', from: now, to: now })).includes(
        'sensitive prompt',
      ),
    );
  } finally {
    await s.close();
  }
});
test('local origin guard, future timestamps and bounded query validation', async () => {
  const s = await setup();
  try {
    assert.equal(
      (
        await s.app.inject({
          url: '/api/dashboard',
          headers: { origin: 'https://attacker.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal((await s.app.inject('/api/logs?limit=10001')).statusCode, 400);
    assert.equal((await s.app.inject('/api/dashboard?from=100&to=1')).statusCode, 400);
    assert.equal(
      (
        await s.app.inject({
          method: 'POST',
          url: '/api/ingest',
          payload: { events: [metric(1, now + 3600000)] },
        })
      ).statusCode,
      400,
    );
  } finally {
    await s.close();
  }
});
test('reserved network destinations are denied, including IPv4-mapped IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.2',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('telemetry capacity rejects atomically and retention removes expired records', () => {
  const store = new Store(':memory:', 2);
  store.append('live', [metric(1), metric(2)]);
  assert.equal(store.append('live', [metric(1)]), 0);
  assert.throws(() => store.append('live', [metric(3)]));
  assert.equal(store.occupancy(), 2);
  assert.equal(store.prune(now + 1), 2);
  store.close();
});
test('asynchronous telemetry adapter works through ingestion, queries and alert evaluation', async () => {
  const control = new Store(':memory:'),
    remote = new Store(':memory:');
  const adapter: TelemetryStore = {
    append: async (w, e) => remote.append(w, e),
    query: async (k, q) => remote.query(k, q),
    occupancy: async () => remote.occupancy(),
    prune: async (t) => remote.prune(t),
  };
  const { app, engine } = await createApp(
    control,
    { mode: 'local', tokens: [], key, allowedHosts: [] },
    adapter,
  );
  try {
    control.put('rule', rule({ durationSec: 0 }));
    const response = await app.inject({
      method: 'POST',
      url: '/api/ingest',
      payload: { workspace: 'live', events: [metric(4)] },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(control.occupancy(), 0);
    assert.equal(remote.occupancy(), 1);
    await engine.evaluate('live', now);
    assert.equal(control.alerts('live').length, 1);
    const d = (await app.inject('/api/dashboard?workspace=live')).json();
    assert.equal(d.services[0].errorPct, 4);
  } finally {
    await app.close();
    control.close();
    remote.close();
  }
});
test('trace query finds old trace despite unrelated recent spans and enforces environment', async () => {
  const s = await setup();
  try {
    const event = {
      kind: 'span' as const,
      timestamp: now,
      service: 'orders',
      environment: 'production',
      traceId: 'exact-trace',
      spanId: 'root',
      name: 'root',
      durationMs: 10,
      status: 'ok' as const,
      attributes: {},
    };
    s.store.append('live', [
      event,
      { ...event, timestamp: now + 1, traceId: 'unrelated', spanId: 'other' },
    ]);
    const r = await s.app.inject('/api/traces/exact-trace?workspace=live&to=' + String(now + 2));
    assert.equal(r.json().items.length, 1);
    assert.equal(r.json().items[0].traceId, 'exact-trace');
    assert.equal(
      (await s.app.inject('/api/traces/exact-trace?workspace=live&environment=staging')).json()
        .items.length,
      0,
    );
  } finally {
    await s.close();
  }
});
test('OTLP HTTP JSON traces map resources and discard content; malformed payload rejected', async () => {
  const s = await setup();
  try {
    const attributes = [
      { key: 'gen_ai.request.model', value: { stringValue: 'sample' } },
      { key: 'gen_ai.input.messages', value: { stringValue: 'sensitive body' } },
    ];
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ai-service' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'otlp-trace',
                  spanId: 'otlp-span',
                  name: 'chat',
                  startTimeUnixNano: String(BigInt(now) * 1000000n),
                  endTimeUnixNano: String(BigInt(now + 25) * 1000000n),
                  attributes,
                  status: { code: 2 },
                },
              ],
            },
          ],
        },
      ],
    };
    assert.equal(
      (await s.app.inject({ method: 'POST', url: '/api/v1/traces?workspace=live', payload }))
        .statusCode,
      200,
    );
    const span = s.store.query('span', { workspace: 'live', from: now, to: now + 100 }).items[0];
    assert.equal(span.service, 'ai-service');
    assert.ok(!JSON.stringify(span).includes('sensitive body'));
    assert.equal(span.kind === 'span' ? span.ai : undefined, undefined);
    assert.equal(
      (await s.app.inject({ method: 'POST', url: '/api/v1/traces', payload: {} })).statusCode,
      400,
    );
  } finally {
    await s.close();
  }
});
test('latest probe recovery is healthy, older failed sample does not override it', async () => {
  const store = new Store(':memory:');
  store.append('live', [
    { ...metric(0, now - 1000), name: 'probe_up' },
    { ...metric(1, now), name: 'probe_up' },
  ]);
  const d = await dashboard(store, { workspace: 'live', from: now - 10000, to: now });
  assert.equal(d.services[0].status, 'healthy');
  store.close();
});
test('synthetic response time is a probe duration, not a request percentile', async () => {
  const store = new Store(':memory:'),
    engine = new Engine(store, key, async () => ({ status: 503, durationMs: 321 }));
  const probe: Probe = {
    id: 'probe',
    workspace: 'live',
    name: 'check',
    service: 'orders',
    environment: 'production',
    url: 'https://example.com',
    enabled: true,
    lastRun: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
  };
  store.put('probe', probe);
  await engine.probes(now);
  const rows = store.query('metric', { workspace: 'live', from: now, to: now }).items;
  assert.ok(
    rows.some((m) => m.kind === 'metric' && m.name === 'probe_duration_ms' && m.value === 321),
  );
  assert.ok(!rows.some((m) => m.kind === 'metric' && m.name === 'latency_p95_ms'));
  assert.equal(store.get<Probe>('probe', 'probe', 'live')?.lastStatus, 503);
  store.close();
});
