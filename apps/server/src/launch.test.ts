import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setup } from '../../../scripts/setup.ts';
import { doctor } from '../../../scripts/doctor.ts';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';
import { requestFlow } from './flow.ts';
import { regionalFlows } from '../../web/src/flow/regions.ts';

test('setup creates private distinct credentials and refuses to rotate an existing installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signaldesk-setup-'));
  try {
    const path = join(dir, '.env');
    assert.equal(await setup(path), path);
    const text = await readFile(path, 'utf8');
    const tokens = JSON.parse(
      text
        .split('\n')
        .find((l) => l.startsWith('ACCESS_TOKENS='))!
        .slice(14),
    );
    assert.deepEqual(
      tokens.map((t: { role: string }) => t.role),
      ['admin', 'viewer', 'ingest'],
    );
    assert.equal(new Set(tokens.map((t: { token: string }) => t.token)).size, 3);
    assert.ok(tokens.every((t: { token: string }) => /^[0-9a-f]{64}$/.test(t.token)));
    assert.deepEqual(tokens[2].workspaces, ['live']);
    assert.equal((await stat(path)).mode & 0o077, 0);
    await assert.rejects(setup(path), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('doctor exercises authenticated runtime reads and keeps manual production evidence unresolved', async () => {
  const store = new Store(':memory:');
  const token = randomBytes(32).toString('hex');
  const { app, engine } = await createApp(store, {
    mode: 'token',
    tokens: [{ token, name: 'operator', role: 'viewer', workspaces: ['live'] }],
    key: randomBytes(32),
    allowedHosts: [],
    requireResourceIdentity: true,
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    await store.append('live', [
      {
        kind: 'metric',
        name: 'request_rate',
        value: 10,
        timestamp: Date.now(),
        service: 'orders',
        environment: 'production',
        module: 'api',
        region: 'ap-northeast-2',
        instanceId: 'orders-1',
      },
    ]);
    await engine.tick();
    const report = await doctor(url, token);
    for (const id of [
      'access',
      'database',
      'worker',
      'capacity',
      'identity-policy',
      'application-telemetry',
      'outbox',
    ])
      assert.equal(report.checks.find((c) => c.id === id)?.status, 'pass', JSON.stringify(report));
    assert.equal(report.checks.find((c) => c.id === 'notification-receipt')?.status, 'warn');
    assert.equal(report.ready, false);
    assert.ok(!JSON.stringify(report).includes(token));
    const denied = await doctor(url, 'invalid');
    assert.equal(denied.checks.find((c) => c.id === 'runtime')?.status, 'fail');
    assert.ok(denied.checks.some((c) => c.detail.includes('HTTP 401')));
  } finally {
    await app.close();
    store.close();
  }
});

test('doctor cannot report an idle worker or empty Live collection as ready', async () => {
  const store = new Store(':memory:');
  const { app } = await createApp(store, {
    mode: 'local',
    tokens: [],
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    await store.append('live', [
      {
        kind: 'metric',
        name: 'request_rate',
        value: 1,
        timestamp: Date.now(),
        service: 'signaldesk-api',
        environment: 'local',
      },
    ]);
    const report = await doctor(url);
    assert.equal(report.checks.find((c) => c.id === 'worker')?.status, 'fail');
    assert.equal(report.checks.find((c) => c.id === 'application-telemetry')?.status, 'warn');
    assert.equal(report.checks.find((c) => c.id === 'identity-policy')?.status, 'warn');
    assert.equal(report.ready, false);
  } finally {
    await app.close();
    store.close();
  }
});

test('doctor refuses credential-bearing URLs and remote cleartext before a fetch', async () => {
  for (const url of [
    'https://user:secret@example.org',
    'https://example.org?token=secret',
    'http://example.org',
    'file:///tmp/settings',
  ])
    await assert.rejects(doctor(url, 'private-token'));
});

test('regional entry totals preserve separate deployments and attribute providers to the observer', async () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now();
    await seedDemo(store, now);
    const flow = await requestFlow(store, store, {
      workspace: 'demo',
      from: now - 3600000,
      to: now,
    });
    const regions = regionalFlows(flow);
    assert.equal(regions.length, 5);
    assert.ok(regions.every((r) => r.incoming > 0 && r.outgoing > 0 && r.services.size > 1));
    assert.equal(
      regions.reduce((n, r) => n + r.incoming, 0),
      flow.edges.filter((e) => e.direction === 'inbound').reduce((n, e) => n + e.count, 0),
    );
    assert.equal(
      regions.reduce((n, r) => n + r.outgoing, 0),
      flow.edges.filter((e) => e.direction === 'outbound').reduce((n, e) => n + e.count, 0),
    );
    assert.ok(!regions.some((r) => ['unobserved', 'all'].includes(r.region)));
  } finally {
    store.close();
  }
});
