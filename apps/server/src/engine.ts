import { notificationPlan, evaluateSLO } from './operations.ts';
import type { SLO } from '../../../packages/contracts/src/index.ts';
import { randomUUID, createHash } from 'node:crypto';
import {
  dimensionKeys,
  identity,
  resourceKey,
  matchesResource,
  type Workspace,
  type Alert,
  type Rule,
  type Metric,
  type ResourceSelector,
  type RuleState,
  type QueryScope,
} from '../../../packages/contracts/src/index.ts';
import type { TelemetryStore } from './store.ts';
import type { Storage } from './storage.ts';
import { decrypt, safeRequest } from './network.ts';
export type Channel = {
  id: string;
  workspace: Workspace;
  name: string;
  encryptedUrl: string;
  enabled: boolean;
  createdAt: number;
};
export type Probe = ResourceSelector & {
  id: string;
  workspace: Workspace;
  name: string;
  service: string;
  environment: string;
  url: string;
  enabled: boolean;
  vantageRegion?: string;
  lastVantageRegion?: string;
  lastWorkerId?: string;
  lastRun: number | null;
  lastStatus: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
};
export type Sender = (
  url: string,
  body?: unknown,
) => Promise<{ status: number; durationMs: number }>;
export const ruleGroup = (
  rule: Rule,
  resource: ResourceSelector & { service: string; environment: string },
) =>
  (rule.groupBy ?? 'resource') === 'service'
    ? 'service'
    : rule.groupBy === 'region'
      ? JSON.stringify([identity(resource).region])
      : resourceKey(resource);
export function ruleValue(metric: Metric['name'], samples: Metric[]): number | null {
  const values = samples.filter((m) => m.name === metric);
  if (!values.length) return null;
  if (metric === 'request_rate' || metric === 'ai_cost_usd')
    return values.reduce((sum, m) => sum + m.value, 0);
  if (metric === 'probe_up') return Math.min(...values.map((m) => m.value));
  if (metric === 'error_pct' && values.length > 1) {
    const rates = new Map(
      samples.filter((m) => m.name === 'request_rate').map((m) => [resourceKey(m), m.value]),
    );
    const pairs = values.map((e) => ({
      error: e.value,
      rate: rates.get(resourceKey(e)),
    }));
    if (pairs.some((p) => p.rate === undefined)) return null;
    const rate = pairs.reduce((sum, p) => sum + p.rate!, 0);
    return rate ? pairs.reduce((sum, p) => sum + p.error * p.rate!, 0) / rate : 0;
  }
  // Percentiles cannot be averaged or merged without histogram distributions.
  return Math.max(...values.map((m) => m.value));
}
export class Engine {
  running = false;
  heartbeat = 0;
  lastError: string | null = null;
  readonly workerId: string;
  constructor(
    readonly store: Storage,
    readonly key: Buffer,
    readonly send: Sender = safeRequest,
    readonly telemetry: TelemetryStore = store,
    readonly workerResource: ResourceSelector = {},
  ) {
    this.workerId = workerResource.instanceId ?? randomUUID();
  }
  async evaluate(workspace: Workspace, now = Date.now()) {
    for (const rule of (await this.store.rules(workspace)).filter((r) => r.enabled))
      await this.store.withWorker('rule:' + rule.id, async () => {
        const scope: QueryScope = {
          workspace,
          from: now - 120000,
          to: now,
          service: rule.service,
          environment: rule.environment,
          ...Object.fromEntries(dimensionKeys.map((key) => [key, rule[key]])),
          limit: 10000,
        };
        const samplePage = this.telemetry.latestMetrics
          ? await this.telemetry.latestMetrics(scope)
          : await this.telemetry.query('metric', scope);
        const inventory = this.telemetry.inventory ? await this.telemetry.inventory(scope) : null;
        if (samplePage.truncated || inventory?.truncated)
          throw new Error('Rule resource coverage exceeded query limit; narrow the rule scope');
        const dedup = new Map<string, Metric>();
        for (const m of samplePage.items as Metric[]) {
          const key = resourceKey(m) + ':' + m.name;
          if (!dedup.has(key)) dedup.set(key, m);
        }
        const samples = [...dedup.values()],
          resources = new Map<
            string,
            ResourceSelector & { service: string; environment: string }
          >();
        const samplesByResource = new Map<string, Metric[]>();
        for (const sample of samples) {
          const id = resourceKey(sample),
            rows = samplesByResource.get(id) ?? [];
          rows.push(sample);
          samplesByResource.set(id, rows);
        }
        const retired = new Set(
          inventory?.items.filter((r) => r.retired).map((r) => resourceKey(r)) ?? [],
        );
        for (const r of inventory?.items.filter((r) => !r.retired) ?? [])
          resources.set(resourceKey(r), r);
        for (const m of samples)
          if (!retired.has(resourceKey(m))) resources.set(resourceKey(m), identity(m));
        const groups = new Map<string, { resource: ResourceSelector; keys: Set<string> }>();
        for (const [key, r] of resources) {
          const groupKey = ruleGroup(rule, r),
            entry = groups.get(groupKey) ?? {
              resource: {
                ...Object.fromEntries(
                  dimensionKeys.filter((key) => rule[key]).map((key) => [key, rule[key]]),
                ),
                ...((rule.groupBy ?? 'resource') === 'resource'
                  ? identity(r)
                  : rule.groupBy === 'region'
                    ? { region: identity(r).region }
                    : {}),
              },
              keys: new Set<string>(),
            };
          entry.keys.add(key);
          groups.set(groupKey, entry);
        }
        // A newly configured service with no observed inventory is explicit unknown, not healthy.
        if (!groups.size && !retired.size)
          groups.set('unobserved', {
            resource: Object.fromEntries(
              dimensionKeys.filter((key) => rule[key]).map((key) => [key, rule[key]]),
            ),
            keys: new Set(),
          });
        const configuration = JSON.stringify({ ...rule, pendingSince: null });
        const sameConfig = async () => {
          const current = await this.store.get<Rule>('rule', rule.id, workspace);
          return current?.enabled &&
            JSON.stringify({ ...current, pendingSince: null }) === configuration
            ? current
            : null;
        };
        const alerts = await this.store.alerts(workspace, rule.id),
          alertMap = new Map(alerts.map((a) => [a.groupKey ?? 'unobserved', a])),
          states = new Map(
            (await this.store.list<RuleState>('rule-state', workspace, { ruleId: rule.id })).map(
              (s) => [s.id, s],
            ),
          );
        const resolve = async (a: Alert) => {
          a.status = 'resolved';
          a.resolvedAt = now;
          const plan = await notificationPlan(this.store, a, now, true);
          await this.store.publishAlert(a, plan.channelIds, {
            key: a.id + ':recovery',
            type: 'recovery',
            time: now,
          });
          await this.store.audit(workspace, 'worker', 'alert.resolved', a.id);
        };
        for (const a of alerts)
          if (!groups.has(a.groupKey ?? 'unobserved'))
            await this.store.withControl(async () => {
              if (!(await sameConfig())) return;
              const fresh = await this.store.get<Alert>('alert', a.id, workspace);
              if (fresh?.status === 'firing') await resolve(fresh);
            });
        for (const state of states.values())
          if (!groups.has(state.groupKey) && state.pendingSince !== null)
            await this.store.withControl(async () => {
              if (!(await sameConfig())) return;
              await this.store.put('rule-state', { ...state, pendingSince: null, lastSeen: now });
            });
        let earliest: number | null = null;
        for (const [groupKey, group] of groups) {
          const groupSamples = [...group.keys].flatMap((key) => samplesByResource.get(key) ?? []),
            value = ruleValue(rule.metric, groupSamples);
          const missing = [...group.keys].some(
              (key) => !(samplesByResource.get(key) ?? []).some((m) => m.name === rule.metric),
            ),
            noData = value === null || missing;
          const violated = noData
            ? rule.noData === 'alert'
            : value !== null &&
              (rule.operator === 'gt' ? value > rule.threshold : value < rule.threshold);
          const id = createHash('sha256')
              .update(JSON.stringify([rule.id, groupKey]))
              .digest('hex'),
            prior = states.get(id),
            state: RuleState =
              prior?.configuration === configuration
                ? prior
                : {
                    id,
                    workspace,
                    ruleId: rule.id,
                    groupKey,
                    resource: group.resource,
                    pendingSince: null,
                    lastSeen: now,
                    configuration,
                  };
          // Short transactions per resource prevent a large rule holding the entire
          // control plane lock. Network work remains outside this transaction.
          const applied = await this.store.withControl(async () => {
            if (!(await sameConfig())) return false;
            const previous = alertMap.get(groupKey),
              active = previous
                ? await this.store.get<Alert>('alert', previous.id, workspace)
                : null;
            if (!violated) {
              if (active?.status === 'firing') await resolve(active);
              state.pendingSince = null;
            } else {
              state.pendingSince ??= now;
              earliest =
                earliest === null ? state.pendingSince : Math.min(earliest, state.pendingSince);
              if (active?.status === 'firing') {
                active.value = value;
                active.reason = noData ? 'no_data' : 'threshold';
                const plan = await notificationPlan(this.store, active, now);
                if (
                  !active.acknowledged &&
                  active.snoozedUntil <= now &&
                  (active.lastNotifiedAt === undefined ||
                    now - active.lastNotifiedAt >= plan.repeatMinutes * 60000) &&
                  plan.channelIds.length
                ) {
                  active.notificationSequence = (active.notificationSequence ?? 0) + 1;
                  active.lastNotifiedAt = now;
                  await this.store.publishAlert(active, plan.channelIds, {
                    key: active.id + ':repeat:' + active.notificationSequence,
                    type: 'repeat',
                    time: now,
                  });
                } else await this.store.put('alert', active);
              } else if (now - state.pendingSince >= rule.durationSec * 1000) {
                const alert: Alert = {
                  id: randomUUID(),
                  workspace,
                  ruleId: rule.id,
                  groupKey,
                  title: rule.name,
                  service: rule.service,
                  environment: rule.environment,
                  ...group.resource,
                  severity: rule.severity,
                  status: 'firing',
                  reason: noData ? 'no_data' : 'threshold',
                  value,
                  createdAt: now,
                  resolvedAt: null,
                  acknowledged: false,
                  snoozedUntil: 0,
                };
                const plan = await notificationPlan(this.store, alert, now);
                alert.lastNotifiedAt = plan.channelIds.length ? now : undefined;
                await this.store.publishAlert(alert, plan.channelIds);
              }
            }
            state.lastSeen = now;
            await this.store.put('rule-state', state);
            return true;
          });
          if (!applied) break;
        }
        await this.store.withControl(async () => {
          const current = await sameConfig();
          if (current) {
            current.pendingSince = earliest;
            await this.store.put('rule', current);
          }
        });
      });
  }
  async evaluateSLOs(workspace: Workspace, now = Date.now()) {
    for (const definition of (await this.store.list<SLO>('slo', workspace)).filter(
      (s) => s.enabled,
    ))
      await this.store.withWorker('slo:' + definition.id, async () => {
        const result = await evaluateSLO(this.telemetry, definition, now);
        await this.store.withControl(async () => {
          const current = await this.store.get<SLO>('slo', definition.id, workspace);
          if (!current?.enabled || current.revision !== definition.revision) return;
          const active = (await this.store.alerts(workspace, 'slo:' + definition.id))[0];
          if (result.status === 'violated' && !active) {
            const alert: Alert = {
              id: randomUUID(),
              workspace,
              ruleId: 'slo:' + definition.id,
              groupKey: 'service',
              title: definition.name + ' error budget burn',
              service: definition.service,
              environment: definition.environment,
              ...Object.fromEntries(
                dimensionKeys.filter((k) => definition[k]).map((k) => [k, definition[k]]),
              ),
              severity: 'warning',
              status: 'firing',
              reason: 'threshold',
              value: result.burnRate,
              createdAt: now,
              resolvedAt: null,
              acknowledged: false,
              snoozedUntil: 0,
            };
            const plan = await notificationPlan(this.store, alert, now);
            alert.lastNotifiedAt = plan.channelIds.length ? now : undefined;
            alert.notificationSequence = 0;
            await this.store.publishAlert(alert, plan.channelIds);
          } else if (active && result.status === 'violated') {
            active.value = result.burnRate;
            const plan = await notificationPlan(this.store, active, now);
            if (
              !active.acknowledged &&
              active.snoozedUntil <= now &&
              plan.channelIds.length &&
              (active.lastNotifiedAt === undefined ||
                now - active.lastNotifiedAt >= plan.repeatMinutes * 60000)
            ) {
              active.notificationSequence = (active.notificationSequence ?? 0) + 1;
              active.lastNotifiedAt = now;
              await this.store.publishAlert(active, plan.channelIds, {
                key: active.id + ':repeat:' + active.notificationSequence,
                type: 'repeat',
                time: now,
              });
            } else await this.store.put('alert', active);
          } else if (active && result.status === 'healthy') {
            active.status = 'resolved';
            active.resolvedAt = now;
            const plan = await notificationPlan(this.store, active, now, true);
            await this.store.publishAlert(active, plan.channelIds, {
              key: active.id + ':recovery',
              type: 'recovery',
              time: now,
            });
          }
        });
      });
  }
  async deliver(now = Date.now()) {
    for (const candidate of await this.store.deliveries(undefined, now))
      await this.store.withWorker('delivery:' + candidate.id, async () => {
        // Re-read after obtaining the cross-process lock; another worker may have completed it.
        const job = (await this.store.deliveries(candidate.workspace, now)).find(
          (j) => j.id === candidate.id,
        );
        if (!job) return;
        const alert = await this.store.get<Alert>('alert', job.alert_id, job.workspace),
          channel = await this.store.get<Channel>('channel', job.channel_id, job.workspace);
        if (
          job.workspace === 'demo' ||
          !alert ||
          !channel?.enabled ||
          (job.event_type === 'recovery'
            ? alert.status !== 'resolved'
            : alert.status === 'resolved' || (job.event_type === 'repeat' && alert.acknowledged))
        ) {
          await this.store.updateDelivery(job.id, { status: 'cancelled' });
          return;
        }
        const plan = await notificationPlan(this.store, alert, now, job.event_type === 'recovery');
        if (!plan.channelIds.includes(job.channel_id)) {
          await this.store.updateDelivery(job.id, {
            status: 'cancelled',
            error: plan.suppressedBy.length
              ? 'Maintenance policy'
              : 'Destination no longer matches routing policy',
          });
          return;
        }
        if (alert.snoozedUntil > now && job.event_type !== 'recovery') {
          await this.store.updateDelivery(job.id, { next_at: alert.snoozedUntil });
          return;
        }
        try {
          const result = await this.send(decrypt(channel.encryptedUrl, this.key), {
            source: 'signaldesk',
            deliveryId: job.id,
            event: job.event_type,
            owner: plan.team,
            investigation: {
              page: 'logs',
              workspace: alert.workspace,
              service: alert.service,
              environment: alert.environment,
              ...Object.fromEntries(dimensionKeys.map((k) => [k, alert[k]])),
              from: alert.createdAt - 300000,
              to: (alert.resolvedAt ?? now) + 300000,
            },
            alert,
          });
          if (result.status < 200 || result.status >= 300)
            throw new Error(`Destination returned HTTP ${result.status}`);
          await this.store.updateDelivery(job.id, {
            status: 'delivered',
            attempts: job.attempts + 1,
            delivered_at: Date.now(),
            error: null,
          });
        } catch (error) {
          await this.store.updateDelivery(job.id, {
            status: job.attempts + 1 >= 5 ? 'failed' : 'pending',
            attempts: job.attempts + 1,
            next_at: now + Math.min(300000, 5000 * 2 ** (job.attempts + 1)),
            error: error instanceof Error ? error.message : 'Delivery failed',
          });
        }
      });
  }
  async probes(now = Date.now()) {
    for (const candidate of (await this.store.list<Probe>('probe', 'live'))
      .filter(
        (p) =>
          p.enabled &&
          (!p.vantageRegion || p.vantageRegion === this.workerResource.region) &&
          (!p.lastRun || now - p.lastRun >= 60000),
      )
      .slice(0, 10))
      await this.store.withWorker('probe:' + candidate.id, async () => {
        const probe = await this.store.get<Probe>('probe', candidate.id, 'live');
        if (
          !probe?.enabled ||
          (probe.vantageRegion && probe.vantageRegion !== this.workerResource.region) ||
          (probe.lastRun && now - probe.lastRun < 60000)
        )
          return;
        let up = 0;
        probe.lastDurationMs = null;
        try {
          const result = await this.send(probe.url);
          probe.lastStatus = result.status;
          probe.lastDurationMs = result.durationMs;
          up = result.status >= 200 && result.status < 300 ? 1 : 0;
          probe.lastError = null;
        } catch (error) {
          probe.lastStatus = null;
          probe.lastError = error instanceof Error ? error.message : 'Probe failed';
        }
        probe.lastRun = now;
        probe.lastVantageRegion = this.workerResource.region ?? 'unknown';
        probe.lastWorkerId = this.workerId;
        // Preserve an operator disable that happened while the network check was running.
        await this.store.withControl(async () => {
          const current = await this.store.get<Probe>('probe', probe.id, 'live');
          if (current)
            await this.store.put('probe', {
              ...current,
              lastRun: probe.lastRun,
              lastStatus: probe.lastStatus,
              lastDurationMs: probe.lastDurationMs,
              lastError: probe.lastError,
              lastVantageRegion: probe.lastVantageRegion,
              lastWorkerId: probe.lastWorkerId,
            });
        });
        const resource = Object.fromEntries(dimensionKeys.map((key) => [key, probe[key]]));
        await this.telemetry.append('live', [
          {
            kind: 'metric',
            timestamp: now,
            service: probe.service,
            environment: probe.environment,
            ...resource,
            name: 'probe_up',
            value: up,
          },
          ...(probe.lastDurationMs !== null
            ? [
                {
                  kind: 'metric' as const,
                  timestamp: now,
                  service: probe.service,
                  environment: probe.environment,
                  ...resource,
                  name: 'probe_duration_ms' as const,
                  value: probe.lastDurationMs,
                },
              ]
            : []),
        ]);
      });
  }
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.store.withWorker('retention', async () => {
        await this.telemetry.prune(now - 7 * 86400000);
      });
      await this.probes(now);
      await this.evaluate('live', now);
      await this.evaluateSLOs('live', now);
      await this.deliver(now);
      this.heartbeat = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Worker failed';
    } finally {
      try {
        await this.store.put('worker', {
          id: this.workerId,
          workspace: 'live',
          ...this.workerResource,
          lastSeen: Date.now(),
          heartbeat: this.heartbeat,
          error: this.lastError,
        });
      } catch (error) {
        this.lastError =
          error instanceof Error ? error.message : 'Worker heartbeat persistence failed';
      }
      this.running = false;
    }
  }
}
