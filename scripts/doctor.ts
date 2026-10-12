import { pathToFileURL } from 'node:url';
import type { Session } from '../packages/contracts/src/session';
import type { ResourceSummary, Page } from '../packages/contracts/src/index';
import type { Connections } from '../apps/web/src/Pages';

type Check = { id: string; status: 'pass' | 'warn' | 'fail'; detail: string };
export type DoctorReport = { target: string; checkedAt: string; checks: Check[]; ready: boolean };
export async function doctor(endpoint: string, token = ''): Promise<DoctorReport> {
  const target = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== '/'
  ) {
    throw new Error('Use an HTTP(S) origin without credentials, a path or query parameters.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'https:' && !loopback) throw new Error('Remote checks require HTTPS.');
  const checks: Check[] = [];
  const check = (id: string, status: Check['status'], detail: string) =>
    checks.push({ id, status, detail });
  const report = () => ({
    target: target.origin,
    checkedAt: new Date().toISOString(),
    checks,
    ready: checks.every((c) => c.status === 'pass'),
  });
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, target), {
      headers: token ? { authorization: 'Bearer ' + token } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return (await response.json()) as T;
  }
  check(
    'transport',
    loopback ? 'warn' : 'pass',
    loopback
      ? 'Loopback preview: remote HTTPS ingress is not verified.'
      : 'HTTPS is required; runtime reads validate the endpoint certificate.',
  );
  try {
    const session = await get<Session>('/api/session');
    check(
      'access',
      session.mode === 'token' ? 'pass' : 'warn',
      session.mode === 'token'
        ? 'Operator authentication succeeded; producer tokens are separate.'
        : 'Local mode is for loopback previews. Enable token mode before opening access.',
    );
    if (!session.workspaces.includes('live')) {
      check(
        'live',
        'fail',
        'This operator token has no Live access. Use a Live viewer or administrator token.',
      );
      return report();
    }
    const [health, bootstrap, connections, resources] = await Promise.all([
      get<{ status: string }>('/health'),
      get<{ capabilities: { requireResourceIdentity: boolean } }>('/api/bootstrap?workspace=live'),
      get<
        Connections & {
          deliveryHealth: { pending: number; failed: number; oldestPendingAt: number | null };
        }
      >('/api/connections?workspace=live'),
      get<Page<ResourceSummary>>('/api/resources?workspace=live&limit=10000'),
    ]);
    check(
      'database',
      health.status === 'ok' ? 'pass' : 'fail',
      `${connections.health.backend} database read ${health.status === 'ok' ? 'succeeded' : 'failed'}. Backup restore and DB TLS need separate verification.`,
    );
    const now = Date.now(),
      age = now - connections.health.workerHeartbeat;
    check(
      'worker',
      connections.health.workerError ||
        !connections.health.workerHeartbeat ||
        age > 30000 ||
        age < -5000
        ? 'fail'
        : 'pass',
      connections.health.workerError
        ? 'Worker reported an error. Inspect protected platform logs.'
        : age > 30000 || !connections.health.workerHeartbeat
          ? 'No successful worker tick within 30 seconds. Check the worker process and shared database.'
          : age < -5000
            ? 'Worker timestamp is ahead of this client. Check clock synchronization.'
            : `Successful worker tick ${Math.max(0, Math.round(age / 1000))}s ago.`,
    );
    const ratio = connections.health.storedEvents / connections.health.capacity;
    check(
      'capacity',
      !Number.isFinite(ratio) || ratio >= 1 ? 'fail' : ratio >= 0.8 ? 'warn' : 'pass',
      `${connections.health.storedEvents} / ${connections.health.capacity} events retained. Measure arrival volume and retention before increasing limits.`,
    );
    check(
      'identity-policy',
      bootstrap.capabilities.requireResourceIdentity ? 'pass' : 'warn',
      bootstrap.capabilities.requireResourceIdentity
        ? 'Producer module, region and instance identity are required.'
        : 'Set REQUIRE_RESOURCE_IDENTITY=true after fixing producer identity.',
    );
    const apps = resources.items.filter(
      (r) =>
        !r.retired &&
        r.observedApplication &&
        !['signaldesk-api', 'local-host'].includes(r.service),
    );
    const incomplete = apps.some(
      (r) =>
        !r.module ||
        !r.region ||
        !r.instanceId ||
        ['unknown', 'unassigned', 'unobserved'].includes(r.region),
    );
    const current = apps.filter(
      (r) => now - r.lastSeen < 300000 && !r.service.startsWith('example-'),
    );
    check(
      'application-telemetry',
      incomplete ? 'fail' : resources.truncated || !current.length ? 'warn' : 'pass',
      incomplete
        ? 'Application observations have incomplete deployment identity.'
        : resources.truncated
          ? 'Inventory reached its page cap; narrow and verify producer coverage separately.'
          : !current.length
            ? 'No recent non-example application producer is confirmed. Instrument an actual service and exercise an inbound and outbound request.'
            : `${current.length} recent application resources observed. Compare expected deployments and sampling separately.`,
    );
    const delivery = connections.deliveryHealth;
    const blocked =
      delivery.failed > 0 ||
      (delivery.oldestPendingAt !== null && now - delivery.oldestPendingAt > 120000);
    check(
      'outbox',
      blocked ? 'fail' : 'pass',
      blocked
        ? 'Failed or older-than-2-minute delivery exists. Inspect delivery health and retry after fixing the destination.'
        : `Delivery backlog: ${delivery.pending} pending, ${delivery.failed} failed.`,
    );
    check(
      'notification-receipt',
      'warn',
      'Send a controlled alert and confirm actual recipient receipt. A stored HTTP receipt alone is not end-to-end acceptance.',
    );
    check(
      'recovery-and-load',
      'warn',
      'Verify backup restore, Collector persistent queues and expected peak volume against the intended infrastructure.',
    );
  } catch (error) {
    const status = /^HTTP \d{3}$/.test((error as Error).message)
      ? (error as Error).message
      : 'connection or response failure';
    check(
      'runtime',
      'fail',
      `Runtime check stopped: ${status}. Check URL, operator token, server and gateway. No secret or upstream response was printed.`,
    );
  }
  return report();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--url' || !args[1])) {
    console.error('Usage: npm run doctor -- [--url https://monitor.example.com]');
    process.exitCode = 1;
  } else {
    try {
      const configured = JSON.parse(process.env.ACCESS_TOKENS ?? '[]') as {
        role: string;
        workspaces: string[];
        token: string;
      }[];
      const token =
        process.env.SIGNALDESK_OPERATOR_TOKEN ??
        configured.find(
          (t) => ['admin', 'viewer'].includes(t.role) && t.workspaces.includes('live'),
        )?.token ??
        '';
      const result = await doctor(args[1] ?? `http://127.0.0.1:${process.env.PORT ?? 4319}`, token);
      console.log(JSON.stringify(result, null, 2));
      // Warnings need manual evidence. Exit 2 distinguishes them from runtime failures (1).
      process.exitCode = result.checks.some((c) => c.status === 'fail') ? 1 : result.ready ? 0 : 2;
    } catch {
      console.error(
        'Could not run doctor. Check the URL and private operator-token configuration.',
      );
      process.exitCode = 1;
    }
  }
}
