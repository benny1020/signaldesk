import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  image = process.argv[2],
  prefix = 'signaldesk-pg-' + randomBytes(5).toString('hex'),
  folder = await mkdtemp(join(tmpdir(), 'signaldesk-pg-'));
const password = randomBytes(24).toString('hex'),
  admin = randomBytes(32).toString('hex'),
  channelKey = randomBytes(32).toString('hex'),
  containers = [],
  network = prefix + '-network';
async function docker(...args) {
  return (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
async function until(fn, timeout = 60000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw last ?? new Error('Acceptance deadline exceeded');
}
const pg = prefix + '-db';
async function base(name, port = '4319/tcp') {
  const mapping = await docker('port', name, port);
  return 'http://' + mapping.split('\n')[0];
}
async function request(url, path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(url + path, {
    method,
    headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}
let apiA, apiB;
const queueVolume = prefix + '-queue';
let queueCreated = false;
try {
  await docker('network', 'create', network);
  const pgEnv = join(folder, 'postgres.env');
  await writeFile(
    pgEnv,
    'POSTGRES_USER=signaldesk\nPOSTGRES_DB=signaldesk_test\nPOSTGRES_PASSWORD=' + password + '\n',
    { mode: 0o600 },
  );
  containers.push(pg);
  await docker(
    'run',
    '-d',
    '--name',
    pg,
    '--network',
    network,
    '--env-file',
    pgEnv,
    '-p',
    '127.0.0.1::5432',
    'postgres:18-bookworm',
  );
  await until(async () => {
    await docker('exec', pg, 'pg_isready', '-U', 'signaldesk', '-d', 'signaldesk_test');
    return true;
  });
  const mapping = await docker('port', pg, '5432/tcp'),
    testUrl =
      'postgres://signaldesk:' + password + '@' + mapping.split('\n')[0] + '/signaldesk_test';
  const tests = await exec(
    process.execPath,
    ['--import', 'tsx', '--test', 'apps/server/src/postgres.integration.ts'],
    { env: { ...process.env, TEST_DATABASE_URL: testUrl }, maxBuffer: 2 * 1024 * 1024 },
  );
  process.stdout.write(tests.stdout);
  if (image) {
    const shared =
      'AUTH_MODE=token\nCHANNEL_KEY=' +
      channelKey +
      '\nACCESS_TOKENS=' +
      JSON.stringify([
        { token: admin, role: 'admin', workspaces: ['live', 'demo'], name: 'acceptance' },
      ]) +
      '\nDATABASE_URL=postgres://signaldesk:' +
      password +
      '@' +
      pg +
      ':5432/signaldesk_test\nCOLLECT_LOCAL=false\nREQUIRE_RESOURCE_IDENTITY=true\nSEED_DEMO=false\n';
    for (const [name, role, region] of [
      ['api-a', 'api', 'seoul'],
      ['api-b', 'api', 'virginia'],
      ['worker-a', 'worker', 'control'],
      ['worker-b', 'worker', 'control'],
    ]) {
      const full = prefix + '-' + name,
        path = join(folder, name + '.env');
      await writeFile(
        path,
        shared + 'APP_ROLE=' + role + '\nINSTANCE_ID=' + name + '\nREGION=' + region + '\n',
        { mode: 0o600 },
      );
      containers.push(full);
      await docker(
        'run',
        '-d',
        '--name',
        full,
        '--network',
        network,
        '--network-alias',
        name,
        '--env-file',
        path,
        ...(role === 'api' ? ['-p', '127.0.0.1::4319'] : []),
        image,
      );
    }
    apiA = await base(prefix + '-api-a');
    apiB = await base(prefix + '-api-b');
    await until(async () => {
      const r = await fetch(apiA + '/health');
      return r.ok;
    });
    await until(async () => {
      const r = await fetch(apiB + '/health');
      return r.ok;
    });
    const gateway = prefix + '-gateway';
    containers.push(gateway);
    await docker(
      'run',
      '-d',
      '--name',
      gateway,
      '--network',
      network,
      '-p',
      '127.0.0.1::8080',
      '-v',
      join(process.cwd(), 'deploy/nginx.conf') + ':/etc/nginx/nginx.conf:ro',
      'nginx:1.30-alpine',
    );
    const gatewayBase = await base(gateway, '8080/tcp');
    await until(async () => (await fetch(gatewayBase + '/health')).ok);
    const stamp = Date.now(),
      specs = [
        ['seoul', 'api', 'pod-1', 80, 0],
        ['seoul', 'worker', 'pod-1', 10, 8],
        ['virginia', 'api', 'pod-1', 5, 0],
        ['virginia', 'worker', 'pod-2', 5, 0],
      ];
    const event = (region, module, instanceId, name, value, timestamp = stamp) => ({
      kind: 'metric',
      id: [region, module, instanceId, name, timestamp].join(':'),
      service: 'replica-demo',
      environment: 'test',
      region,
      module,
      instanceId,
      cluster: 'same-name',
      namespace: 'commerce',
      timestamp,
      name,
      value,
    });
    const events = specs.flatMap(([region, module, id, rate, error]) => [
      event(region, module, id, 'request_rate', rate),
      event(region, module, id, 'error_pct', error),
      event(region, module, id, 'latency_p95_ms', 100),
    ]);
    assert.equal(
      (await request(gatewayBase, '/api/ingest', { workspace: 'live', events })).accepted,
      12,
    );
    assert.equal(
      (await request(apiB, '/api/ingest', { workspace: 'live', events })).duplicates,
      12,
    );
    const dashboard = () =>
      request(apiB, '/api/dashboard?workspace=live&service=replica-demo&environment=test');
    const observed = await dashboard();
    assert.equal(observed.resources.length, 4);
    assert.equal(observed.services[0].requestRate, 100);
    assert.equal(observed.services[0].errorPct, 0.8);
    const rule = await request(apiA, '/api/rules?workspace=live', {
      name: 'Per replica errors',
      service: 'replica-demo',
      environment: 'test',
      metric: 'error_pct',
      operator: 'gt',
      threshold: 2,
      durationSec: 0,
      noData: 'alert',
      groupBy: 'resource',
    });
    const alert = await until(async () => {
      const alerts = (await dashboard()).alerts.filter(
        (a) => a.ruleId === rule.id && a.status === 'firing',
      );
      if (alerts.length === 1) return alerts[0];
    });
    assert.equal(alert.region, 'seoul');
    assert.equal(alert.module, 'worker');
    const incident = await request(apiA, '/api/incidents?workspace=live', {
      title: 'Shared incident',
      service: 'replica-demo',
      environment: 'test',
      region: alert.region,
      module: alert.module,
      instanceId: alert.instanceId,
      alertId: alert.id,
    });
    await Promise.all([
      request(
        apiA,
        '/api/incidents/' + incident.id + '?workspace=live',
        { note: 'API A investigation' },
        'PATCH',
      ),
      request(
        apiB,
        '/api/incidents/' + incident.id + '?workspace=live',
        { note: 'API B investigation' },
        'PATCH',
      ),
    ]);
    const checkNotes = async () => {
      const saved = (await dashboard()).incidents.find((i) => i.id === incident.id);
      assert.ok(saved.timeline.some((t) => t.text === 'API A investigation'));
      assert.ok(saved.timeline.some((t) => t.text === 'API B investigation'));
    };
    await checkNotes();
    await request(apiA, '/api/ingest', {
      workspace: 'live',
      events: [event('seoul', 'worker', 'pod-1', 'error_pct', 0, Date.now())],
    });
    await until(
      async () =>
        !(await dashboard()).alerts.some((a) => a.ruleId === rule.id && a.status === 'firing'),
    );
    await docker('kill', prefix + '-worker-a');
    await request(apiB, '/api/ingest', {
      workspace: 'live',
      events: [event('virginia', 'api', 'pod-1', 'error_pct', 9, Date.now())],
    });
    await until(async () =>
      (await dashboard()).alerts.some(
        (a) => a.ruleId === rule.id && a.status === 'firing' && a.region === 'virginia',
      ),
    );
    await docker('restart', prefix + '-api-a');
    apiA = await base(prefix + '-api-a');
    await until(async () => {
      const r = await fetch(apiA + '/health');
      return r.ok;
    });
    await checkNotes();
    const resource = (await dashboard()).resources.find(
      (r) => r.region === 'virginia' && r.module === 'api',
    );
    await request(
      apiA,
      '/api/resources/' + resource.id + '?workspace=live',
      { retired: true },
      'PATCH',
    );
    await until(
      async () =>
        !(await dashboard()).alerts.some(
          (a) => a.ruleId === rule.id && a.status === 'firing' && a.region === 'virginia',
        ),
    );
    // Actual Collector + persistent file queue. The backend is unavailable while
    // a trace is accepted, and the Collector is restarted before recovery.
    await docker('volume', 'create', queueVolume);
    queueCreated = true;
    await docker(
      'run',
      '--rm',
      '--user',
      '0:0',
      '-v',
      queueVolume + ':/queue',
      image,
      'node',
      '-e',
      "require('fs').chownSync('/queue',10001,10001)",
    );
    const collector = prefix + '-collector',
      collectorEnv = join(folder, 'collector.env');
    await writeFile(
      collectorEnv,
      'REGION=collector-region\nCLUSTER=regional-cluster\nSIGNALDESK_INGEST_TOKEN=' +
        admin +
        '\nSIGNALDESK_TRACES_ENDPOINT=http://' +
        prefix +
        '-api-a:4319/api/v1/traces?workspace=live\n',
      { mode: 0o600 },
    );
    containers.push(collector);
    await docker(
      'run',
      '-d',
      '--name',
      collector,
      '--network',
      network,
      '--env-file',
      collectorEnv,
      '-p',
      '127.0.0.1::4318',
      '-v',
      queueVolume + ':/var/lib/otelcol',
      '-v',
      join(process.cwd(), 'deploy/otel-regional.yaml') + ':/etc/otelcol-contrib/config.yaml:ro',
      'otel/opentelemetry-collector-contrib:0.162.0',
      '--config=/etc/otelcol-contrib/config.yaml',
    );
    const collectorMapping = await docker('port', collector, '4318/tcp'),
      collectorBase = 'http://' + collectorMapping.split('\n')[0];
    await until(async () => {
      const response = await fetch(collectorBase + '/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceSpans: [] }),
      });
      return response.ok;
    });
    await docker('stop', prefix + '-api-a');
    assert.equal(
      (await request(gatewayBase, '/api/dashboard?workspace=live&service=replica-demo')).resources
        .length,
      4,
    );
    const traceId = randomBytes(16).toString('hex'),
      spanId = randomBytes(8).toString('hex'),
      traceTime = Date.now();
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: Object.entries({
              'service.name': 'collector-fixture',
              'service.instance.id': 'collector-pod',
              'service.namespace': 'api',
              'deployment.environment.name': 'test',
            }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
          },
          scopeSpans: [
            {
              scope: { name: 'acceptance' },
              spans: [
                {
                  traceId,
                  spanId,
                  name: 'queued regional request',
                  startTimeUnixNano: String(BigInt(traceTime) * 1000000n),
                  endTimeUnixNano: String(BigInt(traceTime + 12) * 1000000n),
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    assert.ok(
      (
        await fetch(collectorBase + '/v1/traces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      ).ok,
    );
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(
      (await request(apiB, '/api/traces/' + traceId + '?workspace=live')).items.length,
      0,
    );
    await docker('restart', collector);
    await docker('start', prefix + '-api-a');
    apiA = await base(prefix + '-api-a');
    const restored = await until(async () => {
      const page = await request(apiB, '/api/traces/' + traceId + '?workspace=live');
      return page.items.length === 1 ? page.items[0] : null;
    });
    assert.equal(restored.region, 'collector-region');
    assert.equal(restored.cluster, 'regional-cluster');
    assert.equal(restored.instanceId, 'collector-pod');
    console.log(
      JSON.stringify({
        multiProcess: 'passed',
        collectorJsonInteroperability: true,
        regionalTraceQueueSurvivedRestart: true,
        apiReplicas: 2,
        workers: 2,
        regions: 2,
        modules: 2,
        observedResources: 4,
        globalErrorPct: 0.8,
        isolatedResourceErrorPct: 8,
        crossReplicaIdempotency: true,
        concurrentNotesPreserved: true,
        workerExitSurvived: true,
        apiRestartPersistence: true,
        gatewayReadSurvivedApiExit: true,
        retirementStoppedAlert: true,
      }),
    );
  }
} catch (error) {
  // Only diagnostic fixture logs are collected. Never print generated tokens or connection strings.
  const redacted = String(error.stderr ?? error.stdout ?? error.stack ?? error)
    .replaceAll(password, '[redacted]')
    .replaceAll(admin, '[redacted]')
    .replaceAll(channelKey, '[redacted]');
  console.error(redacted);
  process.exitCode = 1;
  for (const name of containers.filter((n) => n.includes('api-') || n.includes('worker-'))) {
    const logs = await docker('logs', '--tail', '15', name).catch(() => '');
    if (logs)
      console.error(
        name +
          ': ' +
          logs
            .replaceAll(password, '[redacted]')
            .replaceAll(admin, '[redacted]')
            .replaceAll(channelKey, '[redacted]'),
      );
  }
} finally {
  for (const name of containers.reverse()) await docker('rm', '-f', '-v', name).catch(() => {});
  await docker('network', 'rm', network).catch(() => {});
  if (queueCreated) await docker('volume', 'rm', queueVolume).catch(() => {});
  await rm(folder, { recursive: true, force: true });
}
