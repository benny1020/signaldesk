import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  dimensionSchema,
  dimensionKeys,
  type ResourceSelector,
  identity,
  resourceKey,
  ingestSchema,
  ruleSchema,
  workspaceSchema,
  type Workspace,
  type QueryScope,
  type Rule,
  type Alert,
  type Incident,
  type TelemetryEvent,
  type Metric,
} from '../../../packages/contracts/src/index.ts';
import { type TelemetryStore, sanitize } from './store.ts';
import type { Storage } from './storage.ts';
import { Engine, ruleGroup, ruleValue, type Channel, type Probe } from './engine.ts';
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
  resource?: ResourceSelector;
  deploymentEnvironment?: string;
  role?: string;
  requireResourceIdentity?: boolean;
};
const scopeSchema = z.object({
  ...dimensionSchema,
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
  ...dimensionSchema,
  title: z.string().min(1).max(180),
  service: z.string().max(100),
  environment: z.string().min(1).max(50).default('production'),
  severity: z.enum(['critical', 'warning']).default('warning'),
  owner: z.string().max(100).default(''),
  alertId: z.string().max(128).optional(),
});
const httpError = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export async function createApp(store: Storage, config: Config, telemetry: TelemetryStore = store) {
  const app = Fastify({
    logger: config.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
  });
  await app.register(compress, {
    globalCompression: false,
    globalDecompression: true,
    requestEncodings: ['gzip'],
  });
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  const engine = new Engine(
    store,
    config.key,
    (url, body) => safeRequest(url, body, config.allowedHosts),
    telemetry,
    config.resource,
  );
  app.addHook('onRoute', (route) => {
    if (
      !route.url.startsWith('/api/') ||
      !['POST', 'PATCH'].includes(String(route.method)) ||
      ['/api/ingest', '/api/v1/traces', '/api/rules/preview'].includes(route.url)
    )
      return;
    const handler = route.handler;
    route.handler = async function (req, reply) {
      return store.withControl(async () => handler.call(this, req, reply));
    };
  });
  const counts = { accepted: 0, rejected: 0, requests: 0, errors: 0, durations: [] as number[] };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (!req.url.startsWith('/api/')) return;
    if (config.role === 'worker') throw httpError('Worker exposes health only', 404);
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
        environment: config.deploymentEnvironment ?? 'local',
        ...config.resource,
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
        environment: config.deploymentEnvironment ?? 'local',
        ...config.resource,
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
    const operationalCode = (error as { code?: string }).code;
    const status = err.statusCode ?? (operationalCode ? 503 : 500);
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
  async function scope(req: FastifyRequest, role: 'read' | 'write' = 'read'): Promise<QueryScope> {
    const q = scopeSchema.parse(req.query),
      workspace = q.workspace;
    access(req, workspace, role);
    const demoNow = await store.setting('demoNow');
    const to = q.to ?? (workspace === 'demo' && demoNow ? Number(demoNow) : Date.now()),
      from = q.from ?? to - q.rangeMinutes * 60000;
    if (from > to || to - from > 7 * 86400000)
      throw httpError('Time range must be ordered and at most seven days');
    return { ...q, to, from };
  }
  const getEntity = async <T>(kind: string, id: string, workspace: Workspace) => {
    const e = await store.get<T>(kind, id, workspace);
    if (!e) throw httpError('Item not found', 404);
    return e;
  };
  const actor = (req: FastifyRequest, w: Workspace) => access(req, w, 'write');
  app.get('/health', async () => {
    await store.setting('demoNow');
    return { status: 'ok', version: '0.2.0', backend: store.backend, role: config.role ?? 'all' };
  });
  app.get('/api/bootstrap', async (req) => {
    const w = workspaceSchema.parse((req.query as { workspace?: string }).workspace ?? 'demo');
    access(req, w);
    return {
      mode: config.mode,
      workspace: w,
      demoNow: Number((await store.setting('demoNow')) ?? Date.now()),
      version: '0.2.0',
      capabilities: {
        nativeJson: true,
        resourceDimensions: dimensionKeys,
        requireResourceIdentity: config.requireResourceIdentity ?? false,
        sharedStorage: store.backend === 'postgres',
        otlpJsonTraces: true,
        otlpProtobuf: false,
        modelDiagnosis: false,
      },
    };
  });
  app.get('/api/resources', async (req) => {
    const q = await scope(req);
    if (!telemetry.inventory) throw httpError('Storage does not implement resource inventory', 501);
    return telemetry.inventory(q);
  });
  app.patch('/api/resources/:id', async (req) => {
    const q = await scope(req, 'write'),
      id = (req.params as { id: string }).id,
      retired = z.object({ retired: z.boolean() }).parse(req.body).retired;
    if (!(await store.retireResource(id, q.workspace, retired)))
      throw httpError('Resource not found', 404);
    await store.audit(
      q.workspace,
      actor(req, q.workspace),
      retired ? 'resource.retired' : 'resource.resumed',
      id,
    );
    return { id, retired };
  });
  app.get('/api/dashboard', async (req) => dashboard(store, await scope(req), telemetry));
  app.get('/api/briefing', async (req) => briefing(store, await scope(req), telemetry));
  app.get('/api/logs', async (req) => telemetry.query('log', await scope(req)));
  app.get('/api/spans', async (req) => telemetry.query('span', await scope(req)));
  app.get('/api/traces/:id', async (req) => {
    const q = await scope(req),
      id = z
        .string()
        .max(128)
        .parse((req.params as { id: string }).id);
    return telemetry.query('span', {
      ...q,
      service: undefined,
      ...Object.fromEntries(dimensionKeys.map((key) => [key, undefined])),
      traceId: id,
      limit: 1000,
    });
  });
  const checkResourceIdentity = (events: TelemetryEvent[]) => {
    if (
      config.requireResourceIdentity &&
      events.some((e) =>
        ['region', 'module', 'instanceId'].some(
          (key) => !e[key as keyof TelemetryEvent] || e[key as keyof TelemetryEvent] === 'unknown',
        ),
      )
    )
      throw httpError(
        'Production ingestion requires explicit region, module and instanceId on every event',
      );
  };
  app.post('/api/ingest', async (req) => {
    const data = ingestSchema.parse(req.body);
    access(req, data.workspace, 'ingest');
    checkResourceIdentity(data.events);
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
            module: resource['signaldesk.module'] ?? resource['service.namespace'],
            region: resource['cloud.region'],
            zone: resource['cloud.availability_zone'],
            cluster: resource['k8s.cluster.name'],
            namespace: resource['k8s.namespace.name'],
            instanceId: resource['service.instance.id'] ?? resource['k8s.pod.uid'],
            host: resource['host.id'] ?? resource['host.name'],
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
    checkResourceIdentity(parsed.events);
    const accepted = await telemetry.append(w, parsed.events.map(sanitize));
    counts.accepted += accepted;
    return { partialSuccess: {} };
  });
  app.post('/api/rules/preview', async (req) => {
    const q = await scope(req),
      input = ruleSchema.parse(req.body),
      selected = {
        ...q,
        ...Object.fromEntries(dimensionKeys.map((key) => [key, input[key]])),
        service: input.service,
        environment: input.environment,
        limit: 10000,
      };
    const [history, latest, inventory] = await Promise.all([
      telemetry.query('metric', { ...selected, metric: input.metric }),
      telemetry.latestMetrics
        ? telemetry.latestMetrics({ ...selected, from: q.to - 120000 })
        : telemetry.query('metric', { ...selected, from: q.to - 120000 }),
      telemetry.inventory ? telemetry.inventory(selected) : null,
    ]);
    const retired = new Set(inventory?.items.filter((r) => r.retired).map(resourceKey) ?? []),
      samples = new Map<string, Metric[]>();
    for (const m of latest.items as Metric[]) {
      const key = resourceKey(m);
      if (retired.has(key)) continue;
      const rows = samples.get(key) ?? [];
      if (!rows.some((r) => r.name === m.name)) rows.push(m);
      samples.set(key, rows);
    }
    const groups = new Map<string, Set<string>>(),
      rule: Rule = { ...input, id: 'preview', workspace: q.workspace, pendingSince: null };
    for (const resource of [
      ...(inventory?.items.filter((r) => !r.retired) ?? []),
      ...latest.items,
    ]) {
      if (retired.has(resourceKey(resource))) continue;
      const key = ruleGroup(rule, identity(resource)),
        group = groups.get(key) ?? new Set<string>();
      group.add(resourceKey(resource));
      groups.set(key, group);
    }
    if (!groups.size && !retired.size) groups.set('unobserved', new Set());
    const values = [...groups].map(([key, resources]) => {
      const rows = [...resources].flatMap((resource) => samples.get(resource) ?? []),
        value = ruleValue(input.metric, rows),
        noData =
          value === null ||
          [...resources].some(
            (resource) => !(samples.get(resource) ?? []).some((m) => m.name === input.metric),
          );
      return {
        key,
        value,
        noData,
        violated: noData
          ? input.noData === 'alert'
          : value !== null &&
            (input.operator === 'gt' ? value > input.threshold : value < input.threshold),
      };
    });
    const known = values.flatMap((v) => (v.value === null ? [] : [v.value]));
    return {
      samples: history.items.length,
      latest: known.length ? Math.max(...known) : null,
      violations: values.filter((v) => v.violated).length,
      groupCount: values.length,
      noDataGroups: values.filter((v) => v.noData).length,
      groups: values.slice(0, 20),
      truncated: history.truncated || latest.truncated || !!inventory?.truncated,
      limitations: 'Current group snapshot only; duration is evaluated by the worker over time',
    };
  });
  app.post('/api/rules', async (req) => {
    const q = await scope(req, 'write');
    if ((await store.rules(q.workspace)).length >= 100) throw httpError('Rule limit reached');
    const rule: Rule = {
      ...ruleSchema.parse(req.body),
      id: randomUUID(),
      workspace: q.workspace,
      pendingSince: null,
    };
    await store.put('rule', rule);
    await store.audit(q.workspace, actor(req, q.workspace), 'rule.created', rule.id);
    return rule;
  });
  app.patch('/api/rules/:id', async (req) => {
    const q = await scope(req, 'write'),
      rule = await getEntity<Rule>('rule', (req.params as { id: string }).id, q.workspace);
    const patch = Object.fromEntries(
      Object.entries(ruleSchema.partial().parse(req.body)).filter(([key]) =>
        Object.hasOwn(req.body as object, key),
      ),
    );
    // Partial edits must not re-apply create-time defaults to omitted fields.
    const next = { ...rule, ...patch, pendingSince: null, revision: (rule.revision ?? 0) + 1 };
    await store.put('rule', next);
    if (!next.enabled)
      for (const a of (await store.alerts(q.workspace, rule.id)).filter(
        (a) => a.ruleId === rule.id && a.status === 'firing',
      )) {
        a.status = 'resolved';
        a.resolvedAt = Date.now();
        await store.put('alert', a);
      }
    await store.audit(q.workspace, actor(req, q.workspace), 'rule.updated', rule.id);
    return next;
  });
  app.patch('/api/alerts/:id', async (req) => {
    const q = await scope(req, 'write'),
      a = await getEntity<Alert>('alert', (req.params as { id: string }).id, q.workspace),
      patch = z
        .object({
          acknowledged: z.boolean().optional(),
          snoozeMinutes: z.number().int().min(0).max(1440).optional(),
        })
        .parse(req.body);
    if (patch.acknowledged !== undefined) a.acknowledged = patch.acknowledged;
    if (patch.snoozeMinutes !== undefined)
      a.snoozedUntil = Date.now() + patch.snoozeMinutes * 60000;
    await store.put('alert', a);
    await store.audit(q.workspace, actor(req, q.workspace), 'alert.updated', a.id);
    return a;
  });
  app.post('/api/incidents', async (req) => {
    const q = await scope(req, 'write'),
      input = incidentInput.parse(req.body);
    if (input.alertId) await getEntity<Alert>('alert', input.alertId, q.workspace);
    if ((await store.incidents(q.workspace)).length >= 1000)
      throw httpError('Incident limit reached');
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
    await store.put('incident', incident);
    await store.audit(q.workspace, actor(req, q.workspace), 'incident.created', incident.id);
    return incident;
  });
  app.patch('/api/incidents/:id', async (req) => {
    const q = await scope(req, 'write'),
      incident = await getEntity<Incident>(
        'incident',
        (req.params as { id: string }).id,
        q.workspace,
      ),
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
    await store.put('incident', incident);
    await store.audit(q.workspace, actor(req, q.workspace), 'incident.updated', incident.id);
    return incident;
  });
  app.get('/api/connections', async (req) => {
    const q = await scope(req);
    const workers =
      q.workspace === 'live'
        ? await store.list<{
            id: string;
            region?: string;
            heartbeat: number;
            lastSeen: number;
            error: string | null;
          }>('worker', 'live')
        : [];
    const currentWorkers = workers.filter((w) => Date.now() - w.lastSeen < 30000);
    return {
      channels: (await store.list<Channel>('channel', q.workspace)).map(
        ({ encryptedUrl, ...c }) => c,
      ),
      probes: await store.list<Probe>('probe', q.workspace),
      deliveries: await store.deliveries(q.workspace),
      health: {
        ...counts,
        durations: undefined,
        storedEvents: await telemetry.occupancy(),
        capacity: store.maxEvents,
        resourceCapacity: store.maxResources,
        backend: store.backend,
        processRole: config.role ?? 'all',
        resource: config.resource,
        workerHeartbeat: Math.max(engine.heartbeat, ...currentWorkers.map((w) => w.heartbeat)),
        workerError: currentWorkers.find((w) => w.error)?.error ?? engine.lastError,
        workers,
        retentionDays: 7,
      },
      audit: await store.auditTrail(q.workspace),
    };
  });
  app.post('/api/channels', async (req) => {
    const q = await scope(req, 'write'),
      input = z
        .object({ name: z.string().min(1).max(100), url: z.url().max(2000) })
        .parse(req.body),
      url = new URL(input.url);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw httpError('An HTTPS URL without embedded credentials is required');
    if (q.workspace === 'demo')
      throw httpError('Notification destinations are available in Live only');
    if ((await store.list('channel', q.workspace)).length >= 20)
      throw httpError('Channel limit reached');
    const c: Channel = {
      id: randomUUID(),
      workspace: q.workspace,
      name: input.name,
      encryptedUrl: encrypt(input.url, config.key),
      enabled: true,
      createdAt: Date.now(),
    };
    await store.put('channel', c);
    await store.audit(q.workspace, actor(req, q.workspace), 'channel.created', c.id);
    return { id: c.id, name: c.name, enabled: c.enabled };
  });
  app.patch('/api/channels/:id', async (req) => {
    const q = await scope(req, 'write'),
      c = await getEntity<Channel>('channel', (req.params as { id: string }).id, q.workspace);
    c.enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await store.put('channel', c);
    await store.audit(q.workspace, actor(req, q.workspace), 'channel.updated', c.id);
    return { id: c.id, name: c.name, enabled: c.enabled };
  });
  app.post('/api/probes', async (req) => {
    const q = await scope(req, 'write'),
      input = z
        .object({
          ...dimensionSchema,
          name: z.string().min(1).max(100),
          service: z.string().min(1).max(100),
          environment: z.string().min(1).max(50).default('production'),
          url: z.url().max(2000),
        })
        .parse(req.body);
    if (q.workspace === 'demo') throw httpError('Synthetic checks are available in Live only');
    if (new URL(input.url).protocol !== 'https:') throw httpError('Use HTTPS');
    if ((await store.list('probe', q.workspace)).length >= 10)
      throw httpError('Probe limit reached');
    const p: Probe = {
      ...input,
      id: randomUUID(),
      workspace: q.workspace,
      enabled: true,
      lastRun: null,
      lastStatus: null,
      lastDurationMs: null,
      lastError: null,
    };
    await store.put('probe', p);
    await store.audit(q.workspace, actor(req, q.workspace), 'probe.created', p.id);
    return p;
  });
  app.patch('/api/probes/:id', async (req) => {
    const q = await scope(req, 'write'),
      p = await getEntity<Probe>('probe', (req.params as { id: string }).id, q.workspace);
    p.enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled;
    await store.put('probe', p);
    await store.audit(q.workspace, actor(req, q.workspace), 'probe.updated', p.id);
    return p;
  });
  app.post('/api/deliveries/:id/retry', async (req) => {
    const q = await scope(req, 'write'),
      id = (req.params as { id: string }).id;
    if (!(await store.retryDelivery(id, q.workspace, Date.now())))
      throw httpError('Failed delivery not found', 404);
    await store.audit(q.workspace, actor(req, q.workspace), 'delivery.retried', id);
    return { retried: true };
  });
  app.get('/api/export', async (req, reply) => {
    const q = await scope(req);
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
