import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresStore } from './postgres.ts';
import { Engine } from './engine.ts';
import { createApp } from './app.ts';
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
  } finally {
    await a.close();
    await b.close();
  }
});
