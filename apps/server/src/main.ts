import { cpus, freemem, totalmem, hostname } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PostgresStore } from './postgres.ts';
import type { Storage } from './storage.ts';
import { dimensionKeys, type ResourceSelector } from '../../../packages/contracts/src/index.ts';
import { Store } from './store.ts';
import { createApp, type Config } from './app.ts';
import { seedDemo } from './seed.ts';
const host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 4319);
process.umask(0o077);
const mode = z.enum(['local', 'token']).parse(process.env.AUTH_MODE ?? 'local');
if (mode === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(host))
  throw new Error('Non-loopback binding requires AUTH_MODE=token');
const tokens = z
  .array(
    z.object({
      token: z.string().min(32),
      role: z.enum(['admin', 'viewer', 'ingest']),
      workspaces: z.array(z.enum(['demo', 'live'])).min(1),
      name: z.string().min(1),
    }),
  )
  .parse(JSON.parse(process.env.ACCESS_TOKENS ?? '[]'));
if (mode === 'token' && !tokens.length) throw new Error('Token mode requires ACCESS_TOKENS');
if (mode === 'token' && !/^[0-9a-fA-F]{64}$/.test(process.env.CHANNEL_KEY ?? ''))
  throw new Error('Token mode requires a 32-byte hex CHANNEL_KEY');
const maxEvents = z.coerce
  .number()
  .int()
  .min(10000)
  .max(10000000)
  .parse(process.env.MAX_EVENTS ?? 1000000);
const maxResources = z.coerce
  .number()
  .int()
  .min(100)
  .max(1000000)
  .parse(process.env.MAX_RESOURCES ?? 20000);
const role = z.enum(['all', 'api', 'worker']).parse(process.env.APP_ROLE ?? 'all');
const backend = z
  .enum(['sqlite', 'postgres'])
  .parse(process.env.STORAGE_BACKEND ?? (process.env.DATABASE_URL ? 'postgres' : 'sqlite'));
const store: Storage =
  backend === 'postgres'
    ? new PostgresStore(
        process.env.DATABASE_URL,
        maxEvents,
        z.coerce
          .number()
          .int()
          .min(2)
          .max(50)
          .parse(process.env.PG_POOL_SIZE ?? 10),
        maxResources,
      )
    : new Store(process.env.DATABASE_PATH ?? 'data/signaldesk.sqlite', maxEvents, maxResources);
if (store instanceof PostgresStore) await store.migrate();
else if (role !== 'all')
  throw new Error('Separate API/worker roles require shared PostgreSQL via DATABASE_URL');
if (process.env.SEED_DEMO !== 'false') await store.withControl(async () => seedDemo(store));
const resource: ResourceSelector = Object.fromEntries(
  dimensionKeys.map((key) => [
    key,
    process.env[
      (
        {
          module: 'MODULE',
          region: 'REGION',
          zone: 'ZONE',
          cluster: 'CLUSTER',
          namespace: 'NAMESPACE',
          instanceId: 'INSTANCE_ID',
        } as const
      )[key]
    ] ??
      (key === 'instanceId'
        ? hostname() + '-' + randomUUID().slice(0, 8)
        : key === 'module'
          ? 'monitoring'
          : undefined),
  ]),
);
const deploymentEnvironment = process.env.ENVIRONMENT ?? 'local';
let keyHex = process.env.CHANNEL_KEY ?? (await store.setting('localChannelKey'));
if (!keyHex) {
  keyHex = randomBytes(32).toString('hex');
  await store.setSetting('localChannelKey', keyHex);
}
if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
  throw new Error('CHANNEL_KEY must contain 64 hexadecimal characters');
const config: Config = {
  mode,
  tokens,
  resource,
  deploymentEnvironment,
  role,
  requireResourceIdentity: process.env.REQUIRE_RESOURCE_IDENTITY === 'true',
  key: Buffer.from(keyHex, 'hex'),
  allowedHosts: (process.env.ALLOWED_DESTINATION_HOSTS ?? '').split(',').filter(Boolean),
  logger: true,
};
const { app, engine, counts } = await createApp(store, config);
await app.listen({ host, port });
let previous = cpus(),
  last = Date.now();
let collecting = false;
const collectLocal = role !== 'worker' && process.env.COLLECT_LOCAL !== 'false';
const collector = collectLocal
  ? setInterval(async () => {
      if (collecting) return;
      collecting = true;
      const now = Date.now(),
        current = cpus();
      let idle = 0,
        total = 0;
      for (let i = 0; i < current.length; i++) {
        const before = previous[i]?.times,
          after = current[i].times;
        if (!before) continue;
        idle += after.idle - before.idle;
        total +=
          Object.values(after).reduce((a, b) => a + b, 0) -
          Object.values(before).reduce((a, b) => a + b, 0);
      }
      const duration = [...counts.durations].sort((a, b) => a - b),
        p95 = duration.length ? duration[Math.ceil(duration.length * 0.95) - 1] : 0;
      try {
        await store.append('live', [
          {
            kind: 'metric',
            timestamp: now,
            service: 'local-host',
            environment: deploymentEnvironment,
            ...resource,
            host: hostname(),
            name: 'cpu_pct',
            value: total ? 100 * (1 - idle / total) : 0,
          },
          {
            kind: 'metric',
            timestamp: now,
            service: 'local-host',
            environment: deploymentEnvironment,
            ...resource,
            host: hostname(),
            name: 'memory_pct',
            value: 100 * (1 - freemem() / totalmem()),
          },
          ...(['request_rate', 'error_pct', 'latency_p95_ms'] as const).map((name) => ({
            kind: 'metric' as const,
            timestamp: now,
            service: 'signaldesk-api',
            environment: deploymentEnvironment,
            ...resource,
            name,
            value:
              name === 'request_rate'
                ? counts.requests / ((now - last) / 1000)
                : name === 'error_pct'
                  ? counts.requests
                    ? (100 * counts.errors) / counts.requests
                    : 0
                  : p95,
          })),
        ]);
      } catch (e) {
        app.log.error(e, 'Local collector failed');
      }
      previous = current;
      last = now;
      counts.requests = 0;
      counts.errors = 0;
      counts.durations = [];
      collecting = false;
    }, 5000)
  : undefined;
const worker = role !== 'api' ? setInterval(() => void engine.tick(), 5000) : undefined;
if (worker) void engine.tick();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (collector) clearInterval(collector);
  if (worker) clearInterval(worker);
  await app.close();
  while (engine.running || collecting) await new Promise((r) => setTimeout(r, 50));
  await store.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
