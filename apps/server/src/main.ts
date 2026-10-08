import { cpus, freemem, totalmem, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
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
const store = new Store(process.env.DATABASE_PATH ?? 'data/signaldesk.sqlite', maxEvents);
seedDemo(store);
let keyHex =
  process.env.CHANNEL_KEY ??
  (
    store.db.prepare("SELECT value FROM settings WHERE key='localChannelKey'").get() as
      { value: string } | undefined
  )?.value;
if (!keyHex) {
  keyHex = randomBytes(32).toString('hex');
  store.db.prepare("INSERT INTO settings VALUES('localChannelKey',?)").run(keyHex);
}
if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
  throw new Error('CHANNEL_KEY must contain 64 hexadecimal characters');
const config: Config = {
  mode,
  tokens,
  key: Buffer.from(keyHex, 'hex'),
  allowedHosts: (process.env.ALLOWED_DESTINATION_HOSTS ?? '').split(',').filter(Boolean),
  logger: true,
};
const { app, engine, counts } = await createApp(store, config);
await app.listen({ host, port });
let previous = cpus(),
  last = Date.now();
const collector = setInterval(() => {
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
    store.append('live', [
      {
        kind: 'metric',
        timestamp: now,
        service: 'local-host',
        environment: 'local',
        host: hostname(),
        name: 'cpu_pct',
        value: total ? 100 * (1 - idle / total) : 0,
      },
      {
        kind: 'metric',
        timestamp: now,
        service: 'local-host',
        environment: 'local',
        host: hostname(),
        name: 'memory_pct',
        value: 100 * (1 - freemem() / totalmem()),
      },
      ...(['request_rate', 'error_pct', 'latency_p95_ms'] as const).map((name) => ({
        kind: 'metric' as const,
        timestamp: now,
        service: 'signaldesk-api',
        environment: 'local',
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
}, 5000);
const worker = setInterval(() => void engine.tick(), 5000);
void engine.tick();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(collector);
  clearInterval(worker);
  await app.close();
  while (engine.running) await new Promise((r) => setTimeout(r, 50));
  store.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
