import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  dimensionKeys,
  teamSchema,
  catalogSchema,
  routeSchema,
  maintenanceSchema,
  sloSchema,
  datasetSchema,
  experimentSchema,
  dependencyMonitorSchema,
  type Workspace,
  type QueryScope,
  type Team,
  type CatalogService,
  type NotificationRoute,
  type Maintenance,
  type SLO,
  type SLOResult,
  type Alert,
  type EvaluationDataset,
  type EvaluationRun,
} from '../../../packages/contracts/src/index.ts';
import type { Storage } from './storage.ts';
import type { TelemetryStore } from './store.ts';
const fail = (text: string, code = 400) => Object.assign(new Error(text), { statusCode: code });
export function matchesPolicy(policy: Record<string, unknown>, alert: Alert) {
  return ['service', 'environment', 'severity', ...dimensionKeys].every(
    (k) => !policy[k] || policy[k] === alert[k as keyof Alert],
  );
}
export async function serviceOwner(store: Storage, workspace: Workspace, service: string) {
  const catalog = (await store.list<CatalogService>('catalog-service', workspace)).find(
    (s) => s.name === service || s.aliases.includes(service),
  );
  const team = catalog?.teamId ? await store.get<Team>('team', catalog.teamId, workspace) : null;
  return { catalog, team };
}
export async function notificationPlan(
  store: Storage,
  alert: Alert,
  now: number,
  recovery = false,
) {
  const { catalog, team } = await serviceOwner(store, alert.workspace, alert.service);
  const maintenance = (await store.list<Maintenance>('maintenance', alert.workspace)).filter(
    (p) => now >= p.from && now < p.to && matchesPolicy(p, alert),
  );
  const configured = await store.list<NotificationRoute>('notification-route', alert.workspace);
  const routes = configured.filter((p) => p.enabled);
  const matched = routes.filter(
    (p) =>
      matchesPolicy(p, alert) &&
      (!p.teamId || p.teamId === catalog?.teamId) &&
      (!recovery || p.notifyRecovery),
  );
  const channels = (
    await store.list<{ id: string; enabled: boolean }>('channel', alert.workspace)
  ).filter((c) => c.enabled);
  const selected = configured.length
    ? channels.filter((c) => matched.some((p) => p.channelIds.includes(c.id)))
    : channels;
  return {
    team: team ?? null,
    serviceId: catalog?.id ?? null,
    matchedRouteIds: matched.map((p) => p.id),
    channelIds: maintenance.length ? [] : selected.map((c) => c.id),
    suppressedBy: maintenance.map((p) => p.id),
    repeatMinutes: matched.length ? Math.min(...matched.map((p) => p.repeatMinutes)) : 30,
    legacyBroadcast: configured.length === 0,
  };
}
export async function evaluateSLO(
  telemetry: TelemetryStore,
  definition: SLO,
  to: number,
): Promise<SLOResult> {
  if (!telemetry.aggregate) throw fail('Telemetry adapter does not support SLI aggregation', 501);
  const from = to - definition.windowMinutes * 60000;
  const result = await telemetry.aggregate('sli', {
    ...definition,
    from,
    to,
    route: definition.route,
    latencyMs: definition.indicator === 'latency' ? definition.latencyMs : undefined,
  });
  const total = Number(result.rows[0]?.total ?? 0),
    bad = Number(result.rows[0]?.bad ?? 0),
    enough = total >= definition.minimumRequests;
  const errorBudget = (100 - definition.objective) / 100;
  const burnRate = total ? bad / total / errorBudget : null;
  return {
    definition,
    total,
    bad,
    successPct: total ? 100 * (1 - bad / total) : null,
    budgetRemainingPct: total ? 100 * (1 - bad / total / errorBudget) : null,
    burnRate,
    status: !enough
      ? 'insufficient'
      : burnRate !== null && burnRate > definition.alertBurnRate
        ? 'violated'
        : 'healthy',
    from,
    to,
    source: 'observed-server-spans',
  };
}
export function runEvaluation(
  dataset: EvaluationDataset,
  input: z.infer<typeof experimentSchema>,
  baseline: EvaluationRun | null,
): EvaluationRun {
  const results = dataset.cases.map((c) => {
    const fields = Object.keys(c.expected);
    const actual = input.actuals ? (input.actuals[c.id] ?? {}) : c.actual;
    const failedFields = fields.filter((k) => actual[k] !== c.expected[k]);
    return {
      caseId: c.id,
      score: fields.length ? 1 - failedFields.length / fields.length : 0,
      failedFields,
    };
  });
  const score = results.reduce((n, r) => n + r.score, 0) / results.length;
  const time = Date.now();
  return {
    ...input,
    id: randomUUID(),
    workspace: dataset.workspace,
    createdAt: time,
    updatedAt: time,
    revision: 1,
    datasetVersion: dataset.version,
    evaluator: 'structured-exact-match-v1',
    score,
    coverage:
      dataset.cases.reduce(
        (n, c) =>
          n +
          Object.keys(c.expected).filter((k) =>
            Object.hasOwn(input.actuals ? (input.actuals[c.id] ?? {}) : c.actual, k),
          ).length,
        0,
      ) /
      Math.max(
        1,
        dataset.cases.reduce((n, c) => n + Object.keys(c.expected).length, 0),
      ),
    results,
    regression: baseline ? score - baseline.score : null,
  };
}
export function registerOperations(
  app: FastifyInstance,
  store: Storage,
  telemetry: TelemetryStore,
  scope: (req: FastifyRequest, role?: 'read' | 'write') => Promise<QueryScope>,
  actor: (req: FastifyRequest, w: Workspace) => string,
) {
  app.get('/api/catalog', async (req) => {
    const q = await scope(req),
      teams = await store.list<Team>('team', q.workspace),
      services = await store.list<CatalogService>('catalog-service', q.workspace);
    const inventory = telemetry.inventory
      ? await telemetry.inventory({ ...q, limit: 10000 })
      : null;
    return {
      teams,
      services: services.map((s) => ({
        ...s,
        owner: teams.find((t) => t.id === s.teamId) ?? null,
      })),
      unowned: [...new Set(inventory?.items.map((r) => r.service) ?? [])].filter(
        (name) => !services.some((s) => s.name === name || s.aliases.includes(name)),
      ),
      inventoryTruncated: inventory?.truncated ?? false,
    };
  });
  const controls = [
    ['teams', 'team', teamSchema],
    ['catalog/services', 'catalog-service', catalogSchema],
    ['notification-routes', 'notification-route', routeSchema],
    ['maintenance', 'maintenance', maintenanceSchema],
    ['slos', 'slo', sloSchema],
    ['dependency-monitors', 'dependency-monitor', dependencyMonitorSchema],
    ['evaluation/datasets', 'evaluation-dataset', datasetSchema],
  ] as const;
  for (const [path, kind, schema] of controls) {
    app.get('/api/' + path, async (req) => {
      const q = await scope(req);
      return {
        items: await store.list(kind, q.workspace),
        ...(kind === 'dependency-monitor'
          ? { statuses: await store.list('dependency-status', q.workspace), observedAt: Date.now() }
          : {}),
      };
    });
    for (const method of ['POST', 'PATCH'] as const)
      app.route({
        method,
        url: '/api/' + path + (method === 'PATCH' ? '/:id' : ''),
        handler: async (req) => {
          const q = await scope(req, 'write');
          const input = schema.parse(req.body) as Record<string, unknown>;
          const id = method === 'PATCH' ? (req.params as { id: string }).id : randomUUID();
          const old =
            method === 'PATCH'
              ? await store.get<{ createdAt: number; revision: number }>(kind, id, q.workspace)
              : null;
          if (method === 'PATCH' && !old) throw fail('Item not found', 404);
          if (
            method === 'POST' &&
            (await store.list(kind, q.workspace)).length >=
              (kind === 'dependency-monitor' ? 50 : 1000)
          )
            throw fail('Control entity limit reached', 507);
          if (kind === 'evaluation-dataset' && old) {
            const existing = await store.get<EvaluationDataset>(kind, id, q.workspace);
            if (
              existing &&
              existing.version === input.version &&
              JSON.stringify(existing.cases) !== JSON.stringify(input.cases)
            )
              throw fail('Dataset content changes require a new version', 409);
          }
          if (kind === 'catalog-service') {
            if (input.teamId && !(await store.get('team', String(input.teamId), q.workspace)))
              throw fail('Team not found', 404);
            const names = [String(input.name), ...(input.aliases as string[])];
            if (
              (await store.list<CatalogService>(kind, q.workspace)).some(
                (s) => s.id !== id && [s.name, ...s.aliases].some((n) => names.includes(n)),
              )
            )
              throw fail('Service names and aliases must be unique', 409);
          }
          if (
            kind === 'notification-route' &&
            input.teamId &&
            !(await store.get('team', String(input.teamId), q.workspace))
          )
            throw fail('Team not found', 404);
          if (kind === 'notification-route')
            for (const channelId of input.channelIds as string[])
              if (!(await store.get('channel', channelId, q.workspace)))
                throw fail('Channel not found', 404);
          const time = Date.now();
          const entity = {
            ...input,
            id,
            workspace: q.workspace,
            createdAt: old?.createdAt ?? time,
            updatedAt: time,
            revision: (old?.revision ?? 0) + 1,
            ...(kind === 'maintenance' ? { actor: actor(req, q.workspace) } : {}),
          };
          await store.put(kind, entity);
          if ((kind === 'slo' || kind === 'dependency-monitor') && input.enabled === false)
            for (const alert of await store.alerts(
              q.workspace,
              (kind === 'slo' ? 'slo:' : 'dependency:') + id,
            )) {
              alert.status = 'resolved';
              alert.resolvedAt = time;
              const plan = await notificationPlan(store, alert, time, true);
              await store.publishAlert(alert, plan.channelIds, {
                key: alert.id + ':recovery',
                type: 'recovery',
                time,
              });
            }
          await store.audit(q.workspace, actor(req, q.workspace), kind + '.saved', id);
          return entity;
        },
      });
  }
  app.get('/api/slos/status', async (req) => {
    const q = await scope(req);
    const definitions = (await store.list<SLO>('slo', q.workspace)).filter(
      (d) =>
        d.enabled &&
        (!q.service || d.service === q.service) &&
        (!q.environment || d.environment === q.environment) &&
        dimensionKeys.every((k) => !q[k] || !d[k] || q[k] === d[k]),
    );
    return { items: await Promise.all(definitions.map((d) => evaluateSLO(telemetry, d, q.to))) };
  });
  app.post('/api/notification-routes/preview', async (req) => {
    const q = await scope(req);
    const input = z
      .object({ alertId: z.string(), at: z.number().int().nonnegative().optional() })
      .parse(req.body);
    const id = input.alertId;
    const alert = await store.get<Alert>('alert', id, q.workspace);
    if (!alert) throw fail('Alert not found', 404);
    const at = input.at ?? Date.now();
    return { ...(await notificationPlan(store, alert, at)), evaluatedAt: at };
  });
  app.get('/api/analysis/:kind', async (req) => {
    const q = await scope(req);
    const kind = z
      .enum(['logBuckets', 'errorGroups', 'apis', 'ai', 'relations', 'metricSeries', 'traces'])
      .parse((req.params as { kind: string }).kind);
    if (!telemetry.aggregate) throw fail('Telemetry adapter requires aggregation support', 501);
    return telemetry.aggregate(kind, q);
  });
  app.post('/api/evaluation/runs', async (req) => {
    const q = await scope(req, 'write'),
      input = experimentSchema.parse(req.body),
      dataset = await store.get<EvaluationDataset>(
        'evaluation-dataset',
        input.datasetId,
        q.workspace,
      );
    if (!dataset) throw fail('Dataset not found', 404);
    const baseline = input.baselineId
      ? await store.get<EvaluationRun>('evaluation-run', input.baselineId, q.workspace)
      : null;
    if (input.baselineId && !baseline) throw fail('Baseline not found', 404);
    if (
      baseline &&
      (baseline.datasetId !== dataset.id || baseline.datasetVersion !== dataset.version)
    )
      throw fail('Baseline must use the same dataset version', 409);
    if ((await store.list('evaluation-run', q.workspace)).length >= 1000)
      throw fail('Evaluation run limit reached', 507);
    if (
      input.actuals &&
      Object.keys(input.actuals).some((id) => !dataset.cases.some((c) => c.id === id))
    )
      throw fail('Actuals contain unknown dataset case IDs');
    const result = runEvaluation(dataset, input, baseline);
    await store.put('evaluation-run', result);
    await store.audit(q.workspace, actor(req, q.workspace), 'evaluation.completed', result.id);
    return result;
  });
  app.get('/api/evaluation/runs', async (req) => {
    const q = await scope(req);
    return { items: await store.list<EvaluationRun>('evaluation-run', q.workspace) };
  });
}
