import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres.ts';
import { Engine } from './engine.ts';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { requestFlow } from './flow.ts';
import { evaluateDependencies } from './dependency-monitor.ts';
import type { Metric, Rule } from '../../../packages/contracts/src/index.ts';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a dedicated TEST_DATABASE_URL with database name ending _test');
const a = new PostgresStore(url),
  b = new PostgresStore(url),
  key = randomBytes(32),
  now = Date.now();
const metric = (instanceId: string, value: number, timestamp = now): Metric => ({
  kind: 'metric',
  id: randomUUID(),
  timestamp,
  service: 'postgres-test',
  environment: 'test',
  module: 'api',
  region: instanceId === 'a' ? 'seoul' : 'virginia',
  cluster: 'same-cluster',
  namespace: 'test',
  instanceId,
  name: 'error_pct',
  value,
});
const rule: Rule = {
  id: randomUUID(),
  workspace: 'live',
  name: 'Scoped errors',
  service: 'postgres-test',
  environment: 'test',
  metric: 'error_pct',
  operator: 'gt',
  threshold: 2,
  durationSec: 0,
  severity: 'warning',
  noData: 'alert',
  enabled: true,
  pendingSince: null,
  groupBy: 'resource',
};
test('real PostgreSQL storage, concurrency and loss-of-lock acceptance', async (t) => {
  try {
    await Promise.all([a.migrate(), b.migrate()]);
    await t.test(
      'atomic duplicate ingestion, history and latest values agree across pools',
      async () => {
        const events = [
          metric('a', 9, now + 1000),
          metric('a', 1, now - 2000),
          metric('a', 4, now - 1000),
          metric('b', 0),
        ];
        const counts = await Promise.all([a.append('live', events), b.append('live', events)]);
        assert.equal(
          counts.reduce((s, n) => s + n, 0),
          4,
        );
        const current = {
          workspace: 'live' as const,
          service: 'postgres-test',
          from: now - 60000,
          to: now,
          region: 'seoul',
        };
        assert.equal((await b.latestMetrics(current)).items[0].value, 4);
        assert.equal((await b.latestMetrics({ ...current, to: now + 1001 })).items[0].value, 9);
        assert.equal((await b.inventory(current)).items[0].firstSeen, now - 2000);
        const occupied = await a.occupancy(),
          limited = new PostgresStore(url!, occupied);
        try {
          assert.equal(await limited.append('live', events), 0);
          await assert.rejects(limited.append('live', [metric('x', 8)]));
          assert.equal(await a.occupancy(), occupied);
        } finally {
          await limited.close();
        }
        assert.equal((await a.query('metric', { ...current, workspace: 'demo' })).items.length, 0);
      },
    );
    await t.test(
      'competing evaluators publish one active alert and preserve acknowledgement',
      async () => {
        await a.put('rule', rule);
        const otherRule = { ...rule, id: randomUUID(), service: 'other-postgres-service' };
        await a.put('rule', otherRule);
        await a.append('live', [{ ...metric('other', 8), service: otherRule.service }]);
        const ea = new Engine(a, key),
          eb = new Engine(b, key);
        await Promise.all([ea.evaluate('live', now), eb.evaluate('live', now)]);
        assert.equal((await b.alerts('live', otherRule.id)).length, 1);
        assert.ok(
          (await a.list<{ ruleId: string }>('rule-state', 'live', { ruleId: rule.id })).every(
            (s) => s.ruleId === rule.id,
          ),
        );
        assert.equal(
          (await b.alerts('live')).filter((x) => x.ruleId === rule.id && x.status === 'firing')
            .length,
          1,
        );
        const { app: apiA } = await createApp(a, {
            mode: 'local',
            tokens: [],
            key,
            allowedHosts: [],
          }),
          { app: apiB } = await createApp(b, { mode: 'local', tokens: [], key, allowedHosts: [] });
        try {
          const alert = (await a.alerts('live')).find((x) => x.ruleId === rule.id)!;
          await Promise.all([
            apiA.inject({
              method: 'PATCH',
              url: '/api/alerts/' + alert.id + '?workspace=live',
              payload: { acknowledged: true },
            }),
            eb.evaluate('live', now),
          ]);
          assert.equal(
            (await b.get<{ acknowledged: boolean }>('alert', alert.id, 'live'))?.acknowledged,
            true,
          );
          const incident = (
            await apiA.inject({
              method: 'POST',
              url: '/api/incidents?workspace=live',
              payload: {
                title: 'Concurrency',
                service: 'postgres-test',
                environment: 'test',
                region: 'seoul',
                alertId: alert.id,
              },
            })
          ).json();
          const replies = await Promise.all([
            apiA.inject({
              method: 'PATCH',
              url: '/api/incidents/' + incident.id + '?workspace=live',
              payload: { note: 'API A note' },
            }),
            apiB.inject({
              method: 'PATCH',
              url: '/api/incidents/' + incident.id + '?workspace=live',
              payload: { note: 'API B note' },
            }),
          ]);
          assert.ok(replies.every((r) => r.statusCode === 200));
          const saved = await a.get<{ timeline: { text: string }[] }>(
            'incident',
            incident.id,
            'live',
          );
          assert.ok(saved?.timeline.some((n) => n.text === 'API A note'));
          assert.ok(saved?.timeline.some((n) => n.text === 'API B note'));
        } finally {
          await apiA.close();
          await apiB.close();
        }
      },
    );
    await t.test(
      'session lock exclusion and connection termination fence the old worker',
      async () => {
        let entered!: () => void, continueOld!: () => void;
        const started = new Promise<void>((r) => {
            entered = r;
          }),
          gate = new Promise<void>((r) => {
            continueOld = r;
          });
        const old = a.withWorker('connection-loss-test', async () => {
          entered();
          await gate;
          await a.setSetting('old-worker-must-not-write', 'bad');
        });
        await started;
        assert.equal(
          await b.withWorker('connection-loss-test', async () => assert.fail('concurrent owner')),
          false,
        );
        const locked = await b.pool.query(
          "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=(hashtext('signaldesk-worker')::bigint & 4294967295)::oid AND objid=(hashtext('connection-loss-test')::bigint & 4294967295)::oid AND granted",
        );
        assert.equal(locked.rows.length, 1);
        await b.pool.query('SELECT pg_terminate_backend($1)', [locked.rows[0].pid]);
        // Allow pg's disconnect event to propagate before the intentionally stale owner writes.
        await new Promise((r) => setTimeout(r, 30));
        continueOld();
        await assert.rejects(old);
        assert.equal(
          await b.withWorker('connection-loss-test', async () => {
            await b.setSetting('new-worker-write', 'ok');
          }),
          true,
        );
        assert.equal(await b.setting('old-worker-must-not-write'), null);
        assert.equal(await b.setting('new-worker-write'), 'ok');
      },
    );
    await t.test(
      'SQL operational aggregation and distinct recovery outbox agree across pools',
      async () => {
        const { evaluateSLO } = await import('./operations.ts');
        await a.append(
          'live',
          Array.from({ length: 1100 }, (_, i) => ({
            kind: 'span' as const,
            id: 'ops-' + i,
            traceId: 'ops-t' + i,
            spanId: 'ops-s' + i,
            timestamp: now - i * 1000,
            service: 'ops-test',
            environment: 'test',
            region: 'seoul',
            name: 'GET /orders/:id',
            durationMs: 100,
            status: i < 33 ? ('error' as const) : ('ok' as const),
            attributes: { 'http.route': '/orders/:id', 'span.kind': 'server' },
          })),
        );
        const q = {
          workspace: 'live' as const,
          service: 'ops-test',
          environment: 'test',
          from: now - 3600000,
          to: now,
        };
        const apis = await b.aggregate('apis', q);
        assert.equal(apis.rows[0].count, 1100);
        assert.equal(apis.rows[0].errors, 33);
        const result = await evaluateSLO(
          b,
          {
            id: 'ops-slo',
            workspace: 'live',
            name: 'SLI',
            service: 'ops-test',
            environment: 'test',
            objective: 99,
            indicator: 'latency',
            latencyMs: 50,
            windowMinutes: 60,
            minimumRequests: 10,
            alertBurnRate: 2,
            enabled: true,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          },
          now,
        );
        assert.equal(result.bad, 1100);
        assert.equal(result.status, 'violated');
        const trace = await b.aggregate('traces', { ...q, route: '/orders/:id' });
        assert.equal(trace.rows.length, 1000);
        assert.equal(trace.truncated, true);
        const metricScope = { ...q, service: 'postgres-test', from: now - 60000, to: now + 2000 };
        const series = await b.aggregate('metricSeries', metricScope);
        assert.ok(series.rows.length > 0);
        const alert = {
          id: 'ops-recovery',
          workspace: 'live' as const,
          ruleId: 'ops-r',
          title: 'test',
          service: 'ops-test',
          environment: 'test',
          severity: 'warning' as const,
          status: 'resolved' as const,
          reason: 'threshold' as const,
          value: 0,
          createdAt: now,
          resolvedAt: now + 1,
          acknowledged: false,
          snoozedUntil: 0,
        };
        await a.publishAlert(alert, ['ops-channel']);
        await b.publishAlert(alert, ['ops-channel'], {
          key: alert.id + ':recovery',
          type: 'recovery',
          time: now + 1,
        });
        await b.publishAlert(alert, ['ops-channel'], {
          key: alert.id + ':recovery',
          type: 'recovery',
          time: now + 1,
        });
        const receipts = (await a.deliveries('live')).filter((d) => d.alert_id === alert.id);
        assert.equal(receipts.length, 2);
        assert.deepEqual(receipts.map((d) => d.event_type).sort(), ['firing', 'recovery']);
      },
    );
    await t.test(
      'request-flow SQL parity, pairing, nested customer outcomes and dependency locks across pools',
      async () => {
        const memory = new Store(':memory:'),
          source = 'flow-source-' + randomUUID(),
          target = 'flow-target-' + randomUUID();
        const base = {
          kind: 'span' as const,
          timestamp: now - 2000,
          service: source,
          environment: 'test',
          region: 'seoul',
          module: 'edge',
          instanceId: 'flow-1',
          name: 'POST /orders',
          durationMs: 300,
          status: 'ok' as const,
          attributes: {},
        };
        const fixture = [
          {
            ...base,
            id: 'flow-root',
            traceId: 'flow-correlated',
            spanId: 'root',
            spanKind: 'server' as const,
          },
          {
            ...base,
            id: 'flow-call',
            traceId: 'flow-correlated',
            spanId: 'call',
            spanKind: 'client' as const,
            parentSpanId: 'root',
          },
          {
            ...base,
            id: 'flow-target',
            traceId: 'flow-correlated',
            spanId: 'target',
            spanKind: 'server' as const,
            parentSpanId: 'call',
            service: target,
            region: 'virginia',
          },
          ...Array.from({ length: 1101 }, (_, i) => ({
            ...base,
            id: 'flow-provider-' + i,
            traceId: 'flow-correlated',
            spanId: 'provider-' + i,
            spanKind: 'client' as const,
            parentSpanId: 'target',
            service: target,
            region: 'virginia',
            durationMs: i + 1,
            status: i < 100 ? ('error' as const) : ('ok' as const),
            attributes: {
              'server.address': 'provider.test',
              'url.template': '/pay',
              'http.request.method': 'POST',
              'http.request.resend_count': i === 1100 ? 'malformed' : i % 2,
            },
          })),
        ];
        try {
          await a.append('live', fixture);
          memory.append('live', fixture);
          const q = {
              workspace: 'live' as const,
              service: target,
              environment: 'test',
              from: now - 60000,
              to: now + 1000,
            },
            pg = await requestFlow(b, b, q),
            local = await requestFlow(memory, memory, q);
          const canonical = (d: typeof pg) => ({
            ...d,
            nodes: d.nodes.sort((x, y) => x.id.localeCompare(y.id)),
            edges: d.edges.sort((x, y) => x.id.localeCompare(y.id)),
          });
          assert.deepEqual(canonical(pg), canonical(local));
          assert.equal(pg.edges.find((e) => e.paired)?.count, 1);
          assert.equal(pg.edges.find((e) => e.count === 1101)?.recoveredRequests, 1);
          assert.equal(pg.edges.find((e) => e.count === 1101)?.p95Ms, 1046);
          const monitor = {
            id: 'pg-dependency',
            workspace: 'live' as const,
            name: 'test',
            service: target,
            environment: 'test',
            dependency: 'provider.test',
            route: '/pay',
            method: 'POST',
            indicator: 'error_pct' as const,
            threshold: 5,
            minimumRequests: 20,
            windowMinutes: 1,
            enabled: true,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          await a.put('dependency-monitor', monitor);
          await Promise.all([
            evaluateDependencies(a, a, 'live', now),
            evaluateDependencies(b, b, 'live', now),
          ]);
          assert.equal((await b.alerts('live', 'dependency:' + monitor.id)).length, 1);
        } finally {
          memory.close();
        }
      },
    );
  } finally {
    await a.close();
    await b.close();
  }
});
