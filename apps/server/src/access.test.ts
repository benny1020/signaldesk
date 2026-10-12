import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { VERSION } from '../../../packages/contracts/src/session.ts';

test('session exposes only the current identity and authorized workspaces without credentials', async () => {
  const store = new Store(':memory:');
  const tokens = ['admin', 'viewer', 'ingest'].map((role) => ({
    name: role,
    role: role as 'admin' | 'viewer' | 'ingest',
    token: randomBytes(32).toString('hex'),
    workspaces: ['live' as const],
  }));
  const { app } = await createApp(store, {
    mode: 'token',
    tokens,
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    assert.equal((await app.inject('/api/session')).statusCode, 401);
    for (const token of tokens) {
      const headers = { authorization: 'Bearer ' + token.token };
      const session = await app.inject({ url: '/api/session', headers });
      if (token.role === 'ingest') {
        assert.equal(session.statusCode, 403);
        continue;
      }
      assert.equal(session.statusCode, 200);
      assert.deepEqual(session.json(), {
        mode: 'token',
        actor: token.name,
        role: token.role,
        workspaces: ['live'],
        defaultWorkspace: 'live',
        canWrite: token.role === 'admin',
        version: VERSION,
      });
      assert.ok(tokens.every((candidate) => !session.body.includes(candidate.token)));
      assert.equal(
        (await app.inject({ url: '/api/bootstrap?workspace=demo', headers })).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ url: '/api/bootstrap?workspace=live', headers })).statusCode,
        200,
      );
      const mutation = await app.inject({
        method: 'POST',
        url: '/api/incidents?workspace=live',
        headers,
        payload: { title: 'Regional incident', service: 'orders' },
      });
      assert.equal(mutation.statusCode, token.role === 'admin' ? 200 : 403);
    }
  } finally {
    await app.close();
    store.close();
  }
});

test('operator responses are non-cacheable and enforce same-origin browser boundaries even on auth failure', async () => {
  const store = new Store(':memory:');
  const { app } = await createApp(store, {
    mode: 'token',
    tokens: [],
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    for (const url of ['/api/session', '/api/bootstrap', '/health']) {
      const response = await app.inject(url);
      assert.equal(response.headers['cache-control'], 'no-store');
      const policy = String(response.headers['content-security-policy']);
      assert.ok(policy.includes("script-src 'self'"));
      assert.ok(policy.includes("worker-src 'self' blob:"));
      assert.ok(policy.includes("frame-ancestors 'none'"));
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    assert.equal((await app.inject('/health')).json().version, VERSION);
  } finally {
    await app.close();
    store.close();
  }
});

test('local operator session remains available without tokens', async () => {
  const store = new Store(':memory:');
  const { app } = await createApp(store, {
    mode: 'local',
    tokens: [],
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    const response = await app.inject('/api/session');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().canWrite, true);
    assert.deepEqual(response.json().workspaces, ['demo', 'live']);
    assert.equal(response.json().defaultWorkspace, 'demo');
  } finally {
    await app.close();
    store.close();
  }
});

test('operator landing prefers Live when authorized and never chooses an unauthorized workspace', async () => {
  const store = new Store(':memory:');
  const tokens = [['demo', 'live'], ['demo']].map((workspaces) => ({
    name: 'operator',
    role: 'viewer' as const,
    workspaces: workspaces as ('demo' | 'live')[],
    token: randomBytes(32).toString('hex'),
  }));
  const { app } = await createApp(store, {
    mode: 'token',
    tokens,
    key: randomBytes(32),
    allowedHosts: [],
  });
  try {
    for (const [index, token] of tokens.entries()) {
      const response = await app.inject({
        url: '/api/session',
        headers: { authorization: 'Bearer ' + token.token },
      });
      assert.equal(response.json().defaultWorkspace, index === 0 ? 'live' : 'demo');
    }
  } finally {
    await app.close();
    store.close();
  }
});
