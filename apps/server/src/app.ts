import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ingestSchema,
  ruleSchema,
  workspaceSchema,
  type Workspace,
  type QueryScope,
  type Rule,
  type Alert,
  type Incident,
  type TelemetryEvent,
} from '../../../packages/contracts/src/index.ts';
import { Store, type TelemetryStore, sanitize } from './store.ts';
import { Engine, type Channel, type Probe } from './engine.ts';
import { encrypt, safeRequest } from './network.ts';
import { dashboard, briefing } from './queries.ts';
export type AccessToken = {
  token: string;
  role: 'admin' | 'viewer' | 'ingest';
  workspaces: Workspace[];
  name: string;
};
export type Config = {
  mode: 'local' | 'token';
  tokens: AccessToken[];
  key: Buffer;
  allowedHosts: string[];
  logger?: boolean;
};
const scopeSchema = z.object({
  workspace: workspaceSchema.default('demo'),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  rangeMinutes: z.coerce.number().int().min(1).max(10080).default(60),
  service: z.string().max(100).optional(),
  environment: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  cursor: z.string().max(1000).optional(),
  search: z.string().max(500).optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});
const incidentInput = z.object({
  title: z.string().min(1).max(180),
  service: z.string().max(100),
  environment: z.string().min(1).max(50).default('production'),
  severity: z.enum(['critical', 'warning']).default('warning'),
  owner: z.string().max(100).default(''),
  alertId: z.string().max(128).optional(),
});
const httpError = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export async function createApp(store: Store, config: Config, telemetry: TelemetryStore = store) {
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const engine = new Engine(
    store,
    config.key,
    (url, body) => safeRequest(url, body, config.allowedHosts),
    telemetry,
  );
  const counts = { accepted: 0, rejected: 0, requests: 0, errors: 0, durations: [] as number[] };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    if (config.mode === 'local') {
      const host = req.hostname.split(':')[0];
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
        throw httpError('Local mode requires a loopback host', 403);
      if (req.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          throw httpError('Invalid origin', 403);
        }
        if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
          throw httpError('Cross-origin access is blocked', 403);
      }
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/assets/')) return;
    counts.requests++;
    if (reply.statusCode >= 500) counts.errors++;
    counts.durations.push(reply.elapsedTime);
    if (counts.durations.length > 2000) counts.durations.shift();
    if (!req.url.startsWith('/api/') || !config.logger) return;
    const timestamp = Date.now(),
      traceId = randomUUID().replaceAll('-', ''),
      name = req.method + ' ' + (req.routeOptions.url ?? '/api/unknown');
    const events: TelemetryEvent[] = [
      {
        kind: 'span',
        timestamp: Math.round(timestamp - reply.elapsedTime),
        service: 'signaldesk-api',
        environment: 'local',
        traceId,
        spanId: traceId.slice(0, 16),
        name,
        durationMs: reply.elapsedTime,
        status: reply.statusCode >= 500 ? 'error' : 'ok',
        attributes: { 'http.response.status_code': reply.statusCode },
      },
    ];
    if (reply.statusCode >= 500)
      events.push({
        kind: 'log',
        timestamp,
        service: 'signaldesk-api',
        environment: 'local',
        level: 'error',
        message: name + ' failed with HTTP ' + reply.statusCode,
        traceId,
        attributes: { 'http.response.status_code': reply.statusCode },
      });
    try {
      await telemetry.append('live', events);
    } catch (e) {
      app.log.error(e, 'Self-instrumentation failed');
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    if (req.url.includes('ingest') || req.url.includes('/v1/traces')) counts.rejected++;
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        error: 'Validation failed',
        details: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }
    const status = err.statusCode ?? 400;
    reply.status(status).send({
      error: status >= 500 ? 'Service unavailable; inspect server health and logs' : err.message,
    });
    if (status >= 500) app.log.error(error);
  });
  function access(
    req: FastifyRequest,
    workspace: Workspace,
    role: 'read' | 'write' | 'ingest' = 'read',
  ) {
    if (config.mode === 'local') return 'local operator';
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const token = config.tokens.find((t) => t.token === bearer);
    if (!token) throw httpError('A valid access token is required', 401);
    if (!token.workspaces.includes(workspace)) throw httpError('Workspace access denied', 403);
    if (
      (role === 'read' && token.role === 'ingest') ||
      (role === 'write' && token.role !== 'admin') ||
      (role === 'ingest' && token.role === 'viewer')
    )
      throw httpError('Role does not permit this action', 403);
    return token.name;
  }
  function scope(req: FastifyRequest, role: 'read' | 'write' = 'read'): QueryScope {
    const q = scopeSchema.parse(req.query),
      workspace = q.workspace;
    access(req, workspace, role);
    const demoNow = (
      store.db.prepare("SELECT value FROM settings WHERE key='demoNow'").get() as
        { value: string } | undefined
    )?.value;
    const to = q.to ?? (workspace === 'demo' && demoNow ? Number(demoNow) : Date.now()),
      from = q.from ?? to - q.rangeMinutes * 60000;
    if (from > to || to - from > 7 * 86400000)
      throw httpError('Time range must be ordered and at most seven days');
    return { ...q, to, from };
  }
  const getEntity = <T>(kind: string, id: string, workspace: Workspace) => {
    const e = store.get<T>(kind, id, workspace);
    if (!e) throw httpError('Item not found', 404);
    return e;
  };
  const actor = (req: FastifyRequest, w: Workspace) => access(req, w, 'write');
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));
  app.get('/api/bootstrap', async (req) => {
    const w = workspaceSchema.parse((req.query as { workspace?: string }).workspace ?? 'demo');
    access(req, w);
    return {
      mode: config.mode,
      workspace: w,
      demoNow: Number(
        (
          store.db.prepare("SELECT value FROM settings WHERE key='demoNow'").get() as
            { value: string } | undefined
        )?.value ?? Date.now(),
      ),
      version: '0.1.0',
      capabilities: {
        nativeJson: true,
        otlpJsonTraces: true,
        otlpProtobuf: false,
        modelDiagnosis: false,
      },
    };
  });
  app.get('/api/dashboard', async (req) => dashboard(store, scope(req), telemetry));
  app.get('/api/briefing', async (req) => briefing(store, scope(req), telemetry));
  app.get('/api/logs', async (req) => telemetry.query('log', scope(req)));
  app.get('/api/spans', async (req) => telemetry.query('span', scope(req)));
  app.get('/api/traces/:id', async (req) => {
    const q = scope(req),
      id = z
        .string()
        .max(128)
        .parse((req.params as { id: string }).id);
    return telemetry.query('span', { ...q, service: undefined, traceId: id, limit: 1000 });
  });
  app.post('/api/ingest', async (req) => {
    const data = ingestSchema.parse(req.body);
    access(req, data.workspace, 'ingest');
    const now = Date.now();
    if (data.events.some((e) => e.timestamp > now + 60000 || e.timestamp < now - 7 * 86400000))
      throw httpError('Events must be within retention and at most 60 seconds in the future');
    const accepted = await telemetry.append(data.workspace, data.events.map(sanitize));
    counts.accepted += accepted;
    return { accepted, duplicates: data.events.length - accepted };
  });
  app.post('/api/v1/traces', async (req) => {
    const w = workspaceSchema.parse((req.query as { workspace?: string }).workspace ?? 'live');
    access(req, w, 'ingest');
    const attr = z.object({
      key: z.string(),
      value: z.object({
        stringValue: z.string().optional(),
        intValue: z.union([z.string(), z.number()]).optional(),
        doubleValue: z.number().optional(),
        boolValue: z.boolean().optional(),
      }),
    });
    const input = z
      .object({
        resourceSpans: z
          .array(
            z.object({
              resource: z.object({ attributes: z.array(attr).optional() }).optional(),
              scopeSpans: z.array(
                z.object({
                  spans: z
                    .array(
                      z.object({
                        traceId: z.string(),
                        spanId: z.string(),
                        parentSpanId: z.string().optional(),
                        name: z.string(),
                        startTimeUnixNano: z.string().regex(/^\d+$/),
                        endTimeUnixNano: z.string().regex(/^\d+$/),
                        attributes: z.array(attr).optional(),
                        status: z.object({ code: z.number() }).optional(),
                      }),
                    )
                    .max(1000),
                }),
              ),
            }),
          )
          .max(100),
      })
      .parse(req.body);
    const map = (as: z.infer<typeof attr>[] = []): Record<string, string | number | boolean> =>
      Object.fromEntries(
        as.map((a) => [
          a.key,
          a.value.stringValue ??
            a.value.doubleValue ??
            a.value.boolValue ??
            Number(a.value.intValue ?? 0),
        ]),
      );
    const events: unknown[] = [];
    for (const rs of input.resourceSpans) {
      const resource = map(rs.resource?.attributes);
      for (const ss of rs.scopeSpans)
        for (const s of ss.spans) {
          const attributes = map(s.attributes),
            get = (key: string) => attributes[key];
          events.push({
            kind: 'span',
            id: s.traceId + ':' + s.spanId,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.name,
            timestamp: Number(BigInt(s.startTimeUnixNano) / 1000000n),
            durationMs: Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1000000,
            service: String(resource['service.name'] ?? 'unknown-service'),
            environment: String(resource['deployment.environment.name'] ?? 'production'),
            status: s.status?.code === 2 ? 'error' : 'ok',
            attributes,
            ...(get('gen_ai.request.model') &&
            get('gen_ai.usage.input_tokens') !== undefined &&
            get('gen_ai.usage.output_tokens') !== undefined
              ? {
                  ai: {
                    provider: String(get('gen_ai.provider.name') ?? 'unknown'),
                    model: String(get('gen_ai.request.model')),
                    inputTokens: Number(get('gen_ai.usage.input_tokens') ?? 0),
                    outputTokens: Number(get('gen_ai.usage.output_tokens') ?? 0),
                  },
                }
              : {}),
          });
        }
    }
    const parsed = ingestSchema.parse({ workspace: w, events }),
      now = Date.now();
    if (parsed.events.some((e) => e.timestamp > now + 60000 || e.timestamp < now - 7 * 86400000))
      throw httpError('Span timestamp outside retention');
    const accepted = await telemetry.append(w, parsed.events.map(sanitize));
    counts.accepted += accepted;
    return { partialSuccess: {} };
  });
  app.post('/api/rules/preview', async (req) => {
    const q = scope(req),
      input = ruleSchema.parse(req.body);
    const page = await telemetry.query('metric', {
        ...q,
        service: input.service,
        environment: input.environment,
        metric: input.metric,
        limit: 10000,
      }),
      rows = page.items;
    const last = rows[0];
    return {
      samples: rows.length,
      latest: last?.kind === 'metric' ? last.value : null,
      violations: rows.filter(
        (e) =>
          e.kind === 'metric' &&
          (input.operator === 'gt' ? e.value > input.threshold : e.value < input.threshold),
      ).length,
      truncated: page.truncated,
    };
  });
  app.post('/api/rules', async (req) => {
    const q = scope(req, 'write');
    if (store.rules(q.workspace).length >= 100) throw httpError('Rule limit reached');
    const rule: Rule = {
      ...ruleSchema.parse(req.body),
      id: randomUUID(),
      workspace: q.workspace,
      pendingSince: null,
    };
    store.put('rule', rule);
    store.audit(q.workspace, actor(req, q.workspace), 'rule.created', rule.id);
    return rule;
  });
  app.patch('/api/rules/:id', async (req) => {
    const q = scope(req, 'write'),
      rule = getEntity<Rule>('rule', (req.params as { id: string }).id, q.workspace);
    const patch = ruleSchema.partial().parse(req.body);
    const next = { ...rule, ...patch, pendingSince: null };
    store.put('rule', next);
    if (!next.enabled)
      for (const a of store
        .alerts(q.workspace)
        .filter((a) => a.ruleId === rule.id && a.status === 'firing')) {
        a.status = 'resolved';
        a.resolvedAt = Date.now();
        store.put('alert', a);
      }
    store.audit(q.workspace, actor(req, q.workspace), 'rule.updated', rule.id);
    return next;
  });
  app.patch('/api/alerts/:id', async (req) => {
    const q = scope(req, 'write'),
      a = getEntity<Alert>('alert', (req.params as { id: string }).id, q.workspace),
      patch = z
        .object({
          acknowledged: z.boolean().optional(),
          snoozeMinutes: z.number().int().min(0).max(1440).optional(),
        })
        .parse(req.body);
    if (patch.acknowledged !== undefined) a.acknowledged = patch.acknowledged;
    if (patch.snoozeMinutes !== undefined)
      a.snoozedUntil = Date.now() + patch.snoozeMinutes * 60000;
    store.put('alert', a);
    store.audit(q.workspace, actor(req, q.workspace), 'alert.updated', a.id);
    return a;
  });
  app.post('/api/incidents', async (req) => {
    const q = scope(req, 'write'),
      input = incidentInput.parse(req.body);
    if (input.alertId) getEntity<Alert>('alert', input.alertId, q.workspace);
    if (store.incidents(q.workspace).length >= 1000) throw httpError('Incident limit reached');
    const now = Date.now(),
      incident: Incident = {
        ...input,
        id: randomUUID(),
        workspace: q.workspace,
        status: 'investigating',
        createdAt: now,
        updatedAt: now,
        timeline: [
          { id: randomUUID(), time: now, text: '장애 등록', actor: actor(req, q.workspace) },
        ],
      };
    store.put('incident', incident);
    store.audit(q.workspace, actor(req, q.workspace), 'incident.created', incident.id);
    return incident;
  });
  app.patch('/api/incidents/:id', async (req) => {
    const q = scope(req, 'write'),
      incident = getEntity<Incident>('incident', (req.params as { id: string }).id, q.workspace),
      patch = z
        .object({
          status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']).optional(),
          owner: z.string().max(100).optional(),
          note: z.string().min(1).max(2000).optional(),
        })
        .parse(req.body);
    if (incident.timeline.length >= 500) throw httpError('Timeline limit reached');
    const texts: string[] = [];
    if (patch.status) {
      incident.status = patch.status;
      texts.push('상태 변경: ' + patch.status);
    }
    if (patch.owner !== undefined) {
      incident.owner = patch.owner;
      texts.push('담당자: ' + (patch.owner || '미지정'));
    }
    if (patch.note) texts.push(patch.note);
    incident.updatedAt = Date.now();
    for (const text of texts)
      incident.timeline.push({
        id: randomUUID(),
        time: incident.updatedAt,
        text,
        actor: actor(req, q.workspace),
      });
    store.put('incident', incident);
    store.audit(q.workspace, actor(req, q.workspace), 'incident.updated', incident.id);
    return incident;
  });
  app.get('/api/connections', async (req) => {
    const q = scope(req);
    return {
      channels: store.list<Channel>('channel', q.workspace).map(({ encryptedUrl, ...c }) => c),
      probes: store.list<Probe>('probe', q.workspace),
      deliveries: store.db
        .prepare(
          'SELECT id,alert_id,channel_id,status,attempts,next_at,error,created_at,delivered_at FROM outbox WHERE workspace=? ORDER BY created_at DESC LIMIT 100',
        )
        .all(q.workspace),
      health: {
        ...counts,
        durations: undefined,
        storedEvents: await telemetry.occupancy(),
        capacity: store.maxEvents,
        workerHeartbeat: engine.heartbeat,
        workerError: engine.lastError,
        retentionDays: 7,
      },
      audit: store.db
        .prepare(
          'SELECT time,actor,action,target FROM audit WHERE workspace=? ORDER BY time DESC LIMIT 100',
        )
        .all(q.workspace),
    };
  });
  app.post('/api/channels', async (req) => {
    const q = scope(req, 'write'),
      input = z
        .object({ name: z.string().min(1).max(100), url: z.url().max(2000) })
        .parse(req.body),
      url = new URL(input.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw httpError('An HTTPS URL without embedded credentials is required');
    if (q.workspace === 'demo')
      throw httpError('Notification destinations are available in Live only');
    if (store.list('channel', q.workspace).length >= 20) throw httpError('Channel limit reached');
    const c: Channel = {
      id: randomUUID(),
      workspace: q.workspace,
      name: input.name,
      encryptedUrl: encrypt(input.url, config.key),
      enabled: true,
      createdAt: Date.now(),
    };
    store.put('channel', c);
    store.audit(q.workspace, actor(req, q.workspace), 'channel.created', c.id);
    return { id: c.id, name: c.name, enabled: c.enabled };
  });
  app.patch('/api/channels/:id', async (req) => {
    const q = scope(req, 'write'),
      c = getEntity<Channel>('channel', (req.params as { id: string }).id, q.workspace);
    c.enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    store.put('channel', c);
    store.audit(q.workspace, actor(req, q.workspace), 'channel.updated', c.id);
    return { id: c.id, name: c.name, enabled: c.enabled };
  });
  app.post('/api/probes', async (req) => {
    const q = scope(req, 'write'),
      input = z
        .object({
          name: z.string().min(1).max(100),
          service: z.string().min(1).max(100),
          environment: z.string().min(1).max(50).default('production'),
          url: z.url().max(2000),
        })
        .parse(req.body);
    if (q.workspace === 'demo') throw httpError('Synthetic checks are available in Live only');
    if (new URL(input.url).protocol !== 'https:') throw httpError('Use HTTPS');
    if (store.list('probe', q.workspace).length >= 10) throw httpError('Probe limit reached');
    const p: Probe = {
      ...input,
      id: randomUUID(),
      workspace: q.workspace,
      enabled: true,
      lastRun: null,
      lastStatus: null,
      lastError: null,
    };
    store.put('probe', p);
    store.audit(q.workspace, actor(req, q.workspace), 'probe.created', p.id);
    return p;
  });
  app.patch('/api/probes/:id', async (req) => {
    const q = scope(req, 'write'),
      p = getEntity<Probe>('probe', (req.params as { id: string }).id, q.workspace);
    p.enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    store.put('probe', p);
    store.audit(q.workspace, actor(req, q.workspace), 'probe.updated', p.id);
    return p;
  });
  app.post('/api/deliveries/:id/retry', async (req) => {
    const q = scope(req, 'write'),
      id = (req.params as { id: string }).id;
    const result = store.db
      .prepare(
        "UPDATE outbox SET status='pending',attempts=0,next_at=? WHERE id=? AND workspace=? AND status='failed'",
      )
      .run(Date.now(), id, q.workspace);
    if (!result.changes) throw httpError('Failed delivery not found', 404);
    store.audit(q.workspace, actor(req, q.workspace), 'delivery.retried', id);
    return { retried: true };
  });
  app.get('/api/export', async (req, reply) => {
    const q = scope(req);
    reply.header('content-disposition', 'attachment; filename=signaldesk-logs.json');
    return telemetry.query('log', { ...q, limit: 10000 });
  });
  const web = resolve('dist/web');
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Route not found' });
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      return reply.sendFile('index.html');
    });
  }
  return { app, engine, counts };
}
