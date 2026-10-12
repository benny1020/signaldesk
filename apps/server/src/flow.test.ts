import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, sanitize } from './store.ts';
import { requestFlow } from './flow.ts';
import { createApp } from './app.ts';
import { evaluateDependencies } from './dependency-monitor.ts';
import { SignalDeskClient } from '../../../packages/sdk/index.js';
import { SignalDeskTracing, parseTraceparent } from '../../../packages/sdk/tracing.node.js';
import type { Span, DependencyMonitor } from '../../../packages/contracts/src/index.ts';
const now = Date.now(),
  scope = { workspace: 'live' as const, from: now - 60000, to: now + 5000 };
export const flowFixture = (patch: Partial<Span>): Span => ({
  kind: 'span',
  id: patch.spanId,
  traceId: 'one',
  spanId: 'root',
  spanKind: 'server',
  timestamp: now - 2000,
  service: 'gateway',
  environment: 'production',
  region: 'seoul',
  module: 'edge',
  instanceId: 'pod1',
  name: 'POST /orders',
  durationMs: 300,
  status: 'ok',
  attributes: {
    'http.route': '/orders',
    'http.request.method': 'POST',
    'http.response.status_code': 200,
  },
  ...patch,
});
export const pairedFixture: Span[] = [
  flowFixture({ spanId: 'root' }),
  flowFixture({
    spanId: 'call',
    spanKind: 'client',
    parentSpanId: 'root',
    timestamp: now - 1900,
    durationMs: 200,
    attributes: {
      'server.address': 'order.internal',
      'url.template': '/orders',
      'http.request.method': 'POST',
    },
  }),
  flowFixture({
    spanId: 'receiver',
    parentSpanId: 'call',
    service: 'orders',
    region: 'virginia',
    module: 'orders',
    timestamp: now - 1880,
    durationMs: 170,
  }),
];
test('paired HTTP edges count caller once, preserve counterpart region and target-service filtering', async () => {
  const s = new Store(':memory:');
  s.append('live', pairedFixture);
  let data = await requestFlow(s, s, scope);
  assert.equal(
    data.edges.reduce((n, e) => n + e.count, 0),
    2,
  );
  const edge = data.edges.find((e) => e.direction === 'outbound')!;
  assert.equal(edge.paired, 1);
  assert.equal(data.nodes.find((n) => n.id === edge.target)?.region, 'virginia');
  assert.equal(edge.p95Ms, 200);
  data = await requestFlow(s, s, { ...scope, service: 'orders', region: 'virginia' });
  assert.equal(data.edges.length, 1);
  assert.equal(data.edges[0].paired, 1);
  assert.equal(data.evidence[0].service, 'gateway');
  s.close();
});
test('nested external failures, retries and recovered customer responses stay distinct', async () => {
  const s = new Store(':memory:');
  s.append('live', [
    flowFixture({ spanId: 'root' }),
    flowFixture({ spanId: 'internal', spanKind: 'internal', parentSpanId: 'root' }),
    flowFixture({
      spanId: 'attempt',
      spanKind: 'client',
      parentSpanId: 'internal',
      status: 'error',
      durationMs: 500,
      attributes: {
        'server.address': 'bank.test',
        'error.type': 'timeout',
        'url.template': '/pay',
        'http.request.resend_count': 0,
      },
    }),
    flowFixture({
      spanId: 'retry',
      spanKind: 'client',
      parentSpanId: 'internal',
      durationMs: 50,
      attributes: {
        'server.address': 'bank.test',
        'url.template': '/pay',
        'http.request.resend_count': 1,
      },
    }),
  ]);
  const d = await requestFlow(s, s, scope),
    e = d.edges.find((e) => e.direction === 'outbound')!;
  assert.equal(e.count, 2);
  assert.equal(e.errors, 1);
  assert.equal(e.retries, 1);
  assert.equal(e.timeouts, 1);
  assert.equal(e.parentRequests, 1);
  assert.equal(e.recoveredRequests, 1);
  assert.equal(e.impactedRequests, 0);
  assert.equal(e.p50Ms, 50);
  assert.equal(e.p95Ms, 500);
  assert.equal(d.evidence[0].parentFailed, false);
  assert.equal(
    d.histogram.reduce((n, h) => n + h.count, 0),
    2,
  );
  s.close();
});
test('HTTP 4xx stays separate on SERVER and CLIENT, 429 is visible and root CLIENT is not an API denominator', async () => {
  const s = new Store(':memory:');
  s.append('live', [
    flowFixture({ spanId: 'server', attributes: { 'http.response.status_code': 429 } }),
    flowFixture({
      spanId: 'client',
      spanKind: 'client',
      attributes: { 'server.address': 'provider.test', 'http.response.status_code': 429 },
    }),
  ]);
  const d = await requestFlow(s, s, scope);
  assert.equal(d.edges.find((e) => e.direction === 'inbound')?.errors, 0);
  const e = d.edges.find((e) => e.direction === 'outbound')!;
  assert.equal(e.errors, 1);
  assert.equal(e.throttled, 1);
  assert.equal(e.parentRequests, 0);
  assert.equal(s.aggregate('sli', scope).rows[0].total, 1);
  s.close();
});
test('dedup uses latest identity and isolates workspace/environment; missing counterpart is unobserved', async () => {
  const s = new Store(':memory:');
  s.append('live', [
    ...pairedFixture,
    flowFixture({ spanId: 'receiver', id: 'other-env', environment: 'staging', service: 'wrong' }),
    flowFixture({
      spanId: 'call',
      id: 'latest-copy',
      spanKind: 'client',
      parentSpanId: 'root',
      timestamp: now - 1800,
      durationMs: 250,
      attributes: { 'server.address': 'order.internal' },
    }),
  ]);
  s.append('demo', [flowFixture({ spanId: 'receiver', service: 'demo' })]);
  const d = await requestFlow(s, s, scope);
  const e = d.edges.find((e) => e.direction === 'outbound')!;
  assert.equal(e.count, 1);
  assert.equal(e.p95Ms, 250);
  assert.equal(d.nodes.find((n) => n.id === e.target)?.name, 'orders');
  const partial = await requestFlow(s, s, { ...scope, from: now - 1850, to: now - 1750 });
  assert.equal(partial.edges[0].count, 1);
  assert.equal(partial.edges[0].paired, 1);
  assert.equal(partial.edges[0].parentRequests, 1);
  s.close();
});
test('whole-window SQL rank quantiles and histogram exceed old 1000-span sample', async () => {
  const s = new Store(':memory:');
  s.append(
    'live',
    Array.from({ length: 1201 }, (_, i) =>
      flowFixture({
        id: 'large' + i,
        traceId: 't' + i,
        spanId: 's' + i,
        spanKind: 'client',
        durationMs: i + 1,
        attributes: { 'server.address': 'provider.test', 'url.template': '/fixed' },
      }),
    ),
  );
  const d = await requestFlow(s, s, scope),
    e = d.edges[0];
  assert.equal(e.count, 1201);
  assert.equal(e.p50Ms, 601);
  assert.equal(e.p95Ms, 1141);
  assert.equal(
    d.histogram.reduce((n, h) => n + h.count, 0),
    1201,
  );
  assert.equal(d.evidence.length, 12);
  s.close();
});
test('raw URL, headers, cookie and baggage are removed before storage; route template remains', () => {
  const clean = sanitize(
    flowFixture({
      attributes: {
        'url.full': 'https://u:p@bank.test/users/42?api_key=private',
        'url.query': 'private',
        'http.request.header.traceparent': 'raw',
        'http.response.header.set-cookie': 'raw',
        baggage: 'private',
        'url.template': '/users/:id',
        'server.address': 'bank.test',
      },
    }),
  );
  assert.equal(Object.keys(clean.kind === 'span' ? clean.attributes : {}).length, 2);
});
test('flow API authenticates, validates edge and maps OTLP CLIENT kinds', async () => {
  const s = new Store(':memory:'),
    { app } = await createApp(s, {
      mode: 'token',
      tokens: [
        { token: 'reader', name: 'read', role: 'viewer', workspaces: ['live'] },
        { token: 'writer', name: 'ingest', role: 'ingest', workspaces: ['live'] },
      ],
      key: randomBytes(32),
      allowedHosts: [],
    });
  assert.equal((await app.inject({ url: '/api/request-flow?workspace=live' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: '/api/request-flow?workspace=live&edge=bad',
        headers: { authorization: 'Bearer reader' },
      })
    ).statusCode,
    400,
  );
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/traces?workspace=live',
    headers: { authorization: 'Bearer writer' },
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: '0'.repeat(31) + '1',
                  spanId: '0'.repeat(15) + '1',
                  kind: 3,
                  name: 'GET',
                  startTimeUnixNano: String(BigInt(now) * 1000000n),
                  endTimeUnixNano: String(BigInt(now + 10) * 1000000n),
                  attributes: [{ key: 'server.address', value: { stringValue: 'bank.test' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.equal(sent.statusCode, 200);
  const got = await app.inject({
    url: '/api/request-flow?workspace=live',
    headers: { authorization: 'Bearer reader' },
  });
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().edges[0].direction, 'outbound');
  await app.close();
  s.close();
});
const listen = (s: Server) =>
  new Promise<string>((r) =>
    s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + (s.address() as AddressInfo).port)),
  );
const close = (s: Server) =>
  new Promise<void>((resolve, reject) => {
    s.close((e) => (e ? reject(e) : resolve()));
    s.closeAllConnections();
  });
test('real HTTP caller → gateway → orders → uninstrumented provider correlates retry and success', async () => {
  const s = new Store(':memory:'),
    { app } = await createApp(s, {
      mode: 'local',
      tokens: [],
      key: randomBytes(32),
      allowedHosts: [],
    });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const endpoint = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port;
  let hits = 0,
    leaked = false;
  const provider = createServer((req, res) => {
    hits++;
    leaked = leaked || !!req.headers.traceparent || !!req.headers.baggage;
    res.writeHead(hits === 1 ? 503 : 200);
    res.end('response');
  });
  const providerURL = await listen(provider);
  const ordersClient = new SignalDeskClient({
      endpoint,
      resource: {
        service: 'orders',
        environment: 'production',
        region: 'virginia',
        module: 'commerce',
        instanceId: 'orders-1',
      },
    }),
    ordersTrace = new SignalDeskTracing({ client: ordersClient, trustIncomingContext: true });
  const orders = createServer((req, res) => {
    void ordersTrace.server(
      {
        method: 'POST',
        route: '/orders',
        headers: { traceparent: req.headers.traceparent as string },
      },
      async () => {
        let r = await ordersTrace.fetch(
          providerURL + '/private?api_key=not-collected',
          { method: 'POST', headers: { baggage: 'remove' } },
          { routeTemplate: '/authorize', resendCount: 0 },
        );
        if (r.status === 503)
          r = await ordersTrace.fetch(
            providerURL + '/private?api_key=not-collected',
            { method: 'POST' },
            { routeTemplate: '/authorize', resendCount: 1 },
          );
        ordersTrace.log('info', 'Order served after provider retry');
        res.writeHead(r.status);
        res.end('done');
        return { status: r.status };
      },
    );
  });
  const ordersURL = await listen(orders);
  const gatewayClient = new SignalDeskClient({
      endpoint,
      resource: {
        service: 'gateway',
        environment: 'production',
        region: 'seoul',
        module: 'edge',
        instanceId: 'gateway-1',
      },
    }),
    gatewayTrace = new SignalDeskTracing({ client: gatewayClient, propagateOrigins: [ordersURL] });
  const gateway = createServer((req, res) => {
    void gatewayTrace.server(
      { method: 'POST', route: '/checkout', caller: 'test mobile' },
      async () => {
        const r = await gatewayTrace.fetch(
          ordersURL + '/orders',
          { method: 'POST' },
          { routeTemplate: '/orders', peerService: 'orders' },
        );
        res.writeHead(r.status);
        res.end(await r.text());
        return { status: r.status };
      },
    );
  });
  const gatewayURL = await listen(gateway);
  try {
    const result = await fetch(gatewayURL + '/checkout', { method: 'POST' });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'done');
    await ordersClient.flush();
    await gatewayClient.flush();
    const q = { workspace: 'live' as const, from: Date.now() - 60000, to: Date.now() + 1000 },
      d = await requestFlow(s, s, q);
    assert.equal(hits, 2);
    assert.equal(leaked, false);
    assert.equal(d.edges.filter((e) => e.paired === 1).length, 1);
    const external = d.edges.find(
      (e) => d.nodes.find((n) => n.id === e.target)?.type === 'dependency',
    )!;
    assert.equal(external.count, 2);
    assert.equal(external.errors, 1);
    assert.equal(external.recoveredRequests, 1);
    assert.equal(external.recoveredEntries, 1);
    assert.equal(external.impactedEntries, 0);
    assert.equal(external.retries, 1);
    assert.equal(s.query('log', q).items.length, 1);
    const stored = JSON.stringify(s.query('span', q));
    assert.ok(!stored.includes('not-collected'));
    assert.equal(
      new Set(s.query('span', q).items.map((e) => (e.kind === 'span' ? e.traceId : ''))).size,
      1,
    );
  } finally {
    await close(gateway);
    await close(orders);
    await close(provider);
    await app.close();
    s.close();
  }
});
test('trace context validates IDs, sampling and strict propagation origins', async () => {
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-' + '1'.repeat(16) + '-01'), null);
  assert.equal(parseTraceparent('bad'), null);
  const events: unknown[] = [],
    client = new SignalDeskClient();
  client.emit = (e) => {
    events.push(e);
    return true;
  };
  let header = '';
  const adapter = new SignalDeskTracing({
    client,
    trustIncomingContext: true,
    propagateOrigins: ['https://trusted.test'],
    fetchImpl: async (_url, init) => {
      header = new Headers(init?.headers).get('traceparent') ?? '';
      return new Response('ok');
    },
  });
  await adapter.server(
    {
      method: 'GET',
      route: '/fixed',
      headers: { traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-00' },
    },
    async () => {
      await adapter.fetch('https://trusted.test?q=private', {}, {});
      return { status: 200 };
    },
  );
  assert.equal(events.length, 0);
  assert.ok(header.endsWith('-00'));
  await assert.rejects(adapter.fetch('https://trusted.test', { redirect: 'follow' }));
  assert.throws(
    () => new SignalDeskTracing({ client, propagateOrigins: ['https://trusted.test/path'] }),
  );
});
test('dependency monitor fires once, holds on missing evidence, recovers and respects disabled revisions', async () => {
  const s = new Store(':memory:'),
    monitor: DependencyMonitor = {
      id: 'dm',
      workspace: 'live',
      name: 'provider rule',
      service: 'gateway',
      environment: 'production',
      dependency: 'bank.test',
      route: '/pay',
      method: 'POST',
      indicator: 'error_pct',
      threshold: 5,
      minimumRequests: 2,
      windowMinutes: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
  s.put('dependency-monitor', monitor);
  s.put('channel', { id: 'channel', workspace: 'live', name: 'fake', enabled: true });
  s.append(
    'live',
    [0, 1].map((i) =>
      flowFixture({
        id: 'fail' + i,
        spanId: 'fail' + i,
        traceId: 'failure' + i,
        spanKind: 'client',
        status: 'error',
        attributes: {
          'server.address': 'bank.test',
          'url.template': '/pay',
          'http.request.method': 'POST',
        },
        timestamp: now - 2000,
      }),
    ),
  );
  await Promise.all([
    evaluateDependencies(s, s, 'live', now),
    evaluateDependencies(s, s, 'live', now),
  ]);
  assert.equal(s.alerts('live', 'dependency:dm').length, 1);
  assert.equal(s.deliveries('live').length, 1);
  await evaluateDependencies(s, s, 'live', now + 65000);
  assert.equal(s.alerts('live', 'dependency:dm').length, 1);
  s.append(
    'live',
    [0, 1].map((i) =>
      flowFixture({
        id: 'good' + i,
        spanId: 'good' + i,
        traceId: 'good' + i,
        spanKind: 'client',
        attributes: {
          'server.address': 'bank.test',
          'url.template': '/pay',
          'http.request.method': 'POST',
        },
        timestamp: now + 64000,
      }),
    ),
  );
  await evaluateDependencies(s, s, 'live', now + 65000);
  assert.equal(s.alerts('live', 'dependency:dm').length, 0);
  assert.deepEqual(
    s
      .deliveries('live')
      .map((d) => d.event_type)
      .sort(),
    ['firing', 'recovery'],
  );
  s.put('dependency-monitor', { ...monitor, enabled: false, revision: 2 });
  await evaluateDependencies(s, s, 'live', now);
  assert.equal(s.alerts('live', 'dependency:dm').length, 0);
  s.close();
});
test('dependency API disable and revision change fence an in-flight evaluator; viewer cannot mutate', async () => {
  const s = new Store(':memory:');
  const { app } = await createApp(s, {
    mode: 'token',
    tokens: [
      { token: 'admin', name: 'test', role: 'admin', workspaces: ['live'] },
      { token: 'viewer', name: 'test', role: 'viewer', workspaces: ['live'] },
    ],
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    const body = {
      name: 'Bank',
      service: 'gateway',
      environment: 'production',
      dependency: 'bank.test',
      route: '/pay',
      method: 'POST',
      indicator: 'error_pct',
      threshold: 5,
      minimumRequests: 1,
      windowMinutes: 1,
      enabled: true,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/dependency-monitors?workspace=live',
      headers: { authorization: 'Bearer admin' },
      payload: body,
    });
    assert.equal(created.statusCode, 200);
    const m = created.json();
    s.append('live', [
      flowFixture({
        spanKind: 'client',
        spanId: 'fenced',
        status: 'error',
        attributes: {
          'server.address': 'bank.test',
          'url.template': '/pay',
          'http.request.method': 'POST',
        },
      }),
    ]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (entered = r));
    const aggregate = s.aggregate.bind(s);
    const held = new Proxy(s, {
      get(target, key) {
        return key === 'aggregate'
          ? async (kind: Parameters<typeof aggregate>[0], q: Parameters<typeof aggregate>[1]) => {
              entered();
              await gate;
              return aggregate(kind, q);
            }
          : Reflect.get(target, key);
      },
    });
    const evaluation = evaluateDependencies(s, held, 'live', now);
    await ready;
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/dependency-monitors/' + m.id + '?workspace=live',
      headers: { authorization: 'Bearer viewer' },
      payload: { ...body, enabled: false },
    });
    assert.equal(denied.statusCode, 403);
    const stopped = await app.inject({
      method: 'PATCH',
      url: '/api/dependency-monitors/' + m.id + '?workspace=live',
      headers: { authorization: 'Bearer admin' },
      payload: { ...body, enabled: false },
    });
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().revision, 2);
    release();
    await evaluation;
    assert.equal(s.alerts('live', 'dependency:' + m.id).length, 0);
    const listed = await app.inject({
      url: '/api/dependency-monitors?workspace=live',
      headers: { authorization: 'Bearer viewer' },
    });
    assert.equal(listed.json().items[0].enabled, false);
    assert.deepEqual(listed.json().statuses, []);
  } finally {
    await app.close();
    s.close();
  }
});
test('nearest service success is distinct from failed entry API; missing entry remains unknown', async () => {
  const s = new Store(':memory:');
  try {
    s.append('live', [
      flowFixture({ spanId: 'entry', service: 'public-api', status: 'error' }),
      flowFixture({
        spanId: 'internal-call',
        parentSpanId: 'entry',
        spanKind: 'client',
        service: 'public-api',
      }),
      flowFixture({ spanId: 'middle', parentSpanId: 'internal-call', service: 'middle-api' }),
      flowFixture({
        spanId: 'external',
        parentSpanId: 'middle',
        spanKind: 'client',
        service: 'middle-api',
        status: 'error',
        attributes: { 'server.address': 'provider.test' },
      }),
      flowFixture({
        spanId: 'partial-server',
        traceId: 'partial',
        parentSpanId: 'missing',
        service: 'middle-api',
      }),
      flowFixture({
        spanId: 'partial-call',
        traceId: 'partial',
        parentSpanId: 'partial-server',
        spanKind: 'client',
        service: 'middle-api',
        status: 'error',
        attributes: { 'server.address': 'partial.test' },
      }),
      flowFixture({
        spanId: 'trusted-entry',
        traceId: 'marked',
        parentSpanId: 'unrecorded-external-client',
        service: 'public-api',
        attributes: { 'signaldesk.entry': true },
      }),
      flowFixture({
        spanId: 'marked-call',
        traceId: 'marked',
        parentSpanId: 'trusted-entry',
        spanKind: 'client',
        service: 'public-api',
        status: 'error',
        attributes: { 'server.address': 'marked.test' },
      }),
    ]);
    const d = await requestFlow(s, s, scope),
      edge = (name: string) =>
        d.edges.find((e) => d.nodes.find((n) => n.id === e.target)?.name === name)!;
    assert.equal(edge('provider.test').recoveredRequests, 1);
    assert.equal(edge('provider.test').recoveredEntries, 0);
    assert.equal(edge('provider.test').impactedEntries, 1);
    const detail = await requestFlow(s, s, scope, edge('provider.test').id);
    assert.equal(detail.evidence[0].parentFailed, false);
    assert.equal(detail.evidence[0].entryFailed, true);
    assert.equal(detail.evidence[0].entryService, 'public-api');
    assert.equal(edge('partial.test').entryRequests, 0);
    const partial = await requestFlow(s, s, scope, edge('partial.test').id);
    assert.equal(partial.evidence[0].entryFailed, null);
    assert.equal(edge('marked.test').entryRequests, 1);
    assert.equal(edge('marked.test').recoveredEntries, 1);
  } finally {
    s.close();
  }
});
