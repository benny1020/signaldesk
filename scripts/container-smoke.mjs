import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const image = process.argv[2] ?? 'signaldesk:local',
  name = 'signaldesk-smoke-' + randomBytes(4).toString('hex');
const dir = mkdtempSync(join(tmpdir(), 'signaldesk-smoke-')),
  envFile = join(dir, 'runtime.env'),
  token = randomBytes(32).toString('hex');
writeFileSync(
  envFile,
  'AUTH_MODE=token\nCHANNEL_KEY=' +
    randomBytes(32).toString('hex') +
    '\nACCESS_TOKENS=' +
    JSON.stringify([{ token, role: 'admin', workspaces: ['live', 'demo'], name: 'smoke' }]),
  { mode: 0o600 },
);
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
let started = false;
try {
  docker(['run', '-d', '--name', name, '--env-file', envFile, '-p', '127.0.0.1::4319', image]);
  started = true;
  let base = 'http://127.0.0.1:' + docker(['port', name, '4319/tcp']).split(':').at(-1);
  async function waitFor(fn) {
    for (let i = 0; i < 40; i++) {
      try {
        const result = await fn();
        if (result) return result;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Container acceptance timed out');
  }
  await waitFor(async () => (await fetch(base + '/health')).ok);
  if ((await fetch(base + '/api/dashboard?workspace=live')).status !== 401)
    throw new Error('Unauthenticated request was not denied');
  async function api(path, body, method = 'POST') {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error('API failed: ' + path + ' ' + response.status);
    return response.json();
  }
  const demo = await api('/api/dashboard?workspace=demo');
  if (demo.services.length !== 6) throw new Error('Demo did not seed six services');
  const event = (value) => ({
    kind: 'metric',
    timestamp: Date.now(),
    service: 'container-smoke-api',
    environment: 'test',
    name: 'error_pct',
    value,
  });
  await api('/api/ingest', { workspace: 'live', events: [event(5)] });
  await api('/api/rules?workspace=live', {
    name: 'Container smoke errors',
    service: 'container-smoke-api',
    environment: 'test',
    metric: 'error_pct',
    operator: 'gt',
    threshold: 2,
    durationSec: 0,
    severity: 'critical',
    noData: 'alert',
  });
  await waitFor(async () => {
    const d = await api('/api/dashboard?workspace=live&service=container-smoke-api');
    return d.alerts.some((a) => a.status === 'firing');
  });
  const incident = await api('/api/incidents?workspace=live', {
    title: 'Container smoke incident',
    service: 'container-smoke-api',
    environment: 'test',
  });
  await api(
    '/api/incidents/' + incident.id + '?workspace=live',
    { note: 'Persisted across container restart' },
    'PATCH',
  );
  await api('/api/ingest', { workspace: 'live', events: [event(0)] });
  await waitFor(async () => {
    const d = await api('/api/dashboard?workspace=live&service=container-smoke-api');
    return d.alerts.some((a) => a.status === 'resolved');
  });
  docker(['restart', name]);
  base = 'http://127.0.0.1:' + docker(['port', name, '4319/tcp']).split(':').at(-1);
  await waitFor(async () => (await fetch(base + '/health')).ok);
  const live = await api('/api/dashboard?workspace=live&service=container-smoke-api');
  if (
    !live.incidents.some(
      (i) =>
        i.id === incident.id &&
        i.timeline.some((t) => t.text === 'Persisted across container restart'),
    )
  )
    throw new Error('Incident persistence failed');
  console.log(
    JSON.stringify({
      container: 'passed',
      nodeRuntime: docker(['exec', name, 'node', '--version']),
      unauthenticatedDenied: true,
      demoServices: demo.services.length,
      alertFiredAndRecovered: true,
      restartPersistence: true,
    }),
  );
} finally {
  if (started) docker(['rm', '-f', '-v', name]);
  rmSync(dir, { recursive: true, force: true });
}
