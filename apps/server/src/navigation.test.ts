import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  navigationHref,
  navigationGroups,
  matchesNavigation,
  navigationServices,
} from '../../web/src/navigation-model.ts';
import type { ResourceSummary } from '../../../packages/contracts/src/index.ts';

test('all navigation layers preserve independent deployment and time scope while clearing page-specific evidence', () => {
  const scope = new URLSearchParams({
    workspace: 'live',
    page: 'overview',
    environment: 'production',
    service: 'orders',
    region: 'ap-northeast-2',
    module: 'api',
    zone: 'ap-northeast-2a',
    cluster: 'seoul-prod',
    namespace: 'commerce',
    instanceId: 'pod-1',
    from: '1700000000000',
    to: '1700000300000',
    timezone: 'Asia/Seoul',
    detail: 'trace',
    detailId: 'trace-1',
    edge: 'selected-edge',
    search: 'timeout',
    level: 'error',
    route: '/orders',
  });
  const next = new URLSearchParams(navigationHref(scope, 'incidents').slice(1));
  assert.equal(next.get('page'), 'incidents');
  for (const key of [
    'workspace',
    'environment',
    'service',
    'region',
    'module',
    'zone',
    'cluster',
    'namespace',
    'instanceId',
    'from',
    'to',
    'timezone',
  ])
    assert.equal(next.get(key), scope.get(key), key);
  for (const key of ['detail', 'detailId', 'edge', 'search', 'level', 'route'])
    assert.equal(next.has(key), false, key);
  assert.equal(
    scope.get('detailId'),
    'trace-1',
    'building a link must not mutate the current investigation',
  );
  assert.equal(
    new URLSearchParams(navigationHref(scope, 'relations').slice(1)).get('page'),
    'overview',
  );
});

test('task searches find external APIs and maintenance without confusing AI with maintenance', () => {
  const results = (search: string) =>
    navigationGroups.flatMap((group) =>
      group.items.filter((item) => matchesNavigation(group, item, search)).map((item) => item.key),
    );
  assert.deepEqual(results('외부 API'), ['overview']);
  assert.deepEqual(results('유지보수'), ['policies']);
  assert.deepEqual(results(' AI '), ['ai']);
  assert.deepEqual(results('sLo'), ['slos']);
  assert.deepEqual(results('unknown-menu-name'), []);
});

test('quick service switching can leave the current service without crossing the selected deployment', () => {
  const resource = (service: string, patch: Partial<ResourceSummary> = {}): ResourceSummary => ({
    id: service,
    service,
    environment: 'production',
    module: 'api',
    region: 'ap-northeast-2',
    zone: 'ap-northeast-2a',
    cluster: 'seoul-prod',
    namespace: 'commerce',
    instanceId: 'pod-1',
    observedApplication: true,
    retired: false,
    firstSeen: 1,
    lastSeen: 2,
    requestRate: null,
    errorPct: null,
    latency: null,
    status: 'unknown',
    ...patch,
  });
  const results = navigationServices(
    [
      resource('orders'),
      resource('auth'),
      resource('auth', { instanceId: 'pod-2' }),
      resource('orders', { region: 'eu-west-1' }),
      resource('auth', { environment: 'staging' }),
      resource('payments', { module: 'worker' }),
      resource('retired', { retired: true }),
      resource('host', { observedApplication: false }),
    ],
    { service: 'orders', environment: 'production', region: 'ap-northeast-2', module: 'api' },
  );
  assert.deepEqual(results, [
    { name: 'auth', environment: 'production' },
    { name: 'orders', environment: 'production' },
  ]);
});
