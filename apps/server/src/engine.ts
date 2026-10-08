import { randomUUID } from 'node:crypto';
import type { Workspace, Alert, Rule, Metric } from '../../../packages/contracts/src/index.ts';
import { Store, type TelemetryStore } from './store.ts';
import { decrypt, safeRequest } from './network.ts';
export type Channel = {
  id: string;
  workspace: Workspace;
  name: string;
  encryptedUrl: string;
  enabled: boolean;
  createdAt: number;
};
export type Probe = {
  id: string;
  workspace: Workspace;
  name: string;
  service: string;
  environment: string;
  url: string;
  enabled: boolean;
  lastRun: number | null;
  lastStatus: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
};
export type Sender = (
  url: string,
  body?: unknown,
) => Promise<{ status: number; durationMs: number }>;
export class Engine {
  running = false;
  heartbeat = 0;
  lastError: string | null = null;
  constructor(
    readonly store: Store,
    readonly key: Buffer,
    readonly send: Sender = safeRequest,
    readonly telemetry: TelemetryStore = store,
  ) {}
  async evaluate(workspace: Workspace, now = Date.now()) {
    for (const rule of this.store.rules(workspace).filter((r) => r.enabled)) {
      const samples = (
        await this.telemetry.query('metric', {
          workspace,
          from: now - 120000,
          to: now,
          service: rule.service,
          environment: rule.environment,
          metric: rule.metric,
          limit: 1,
        })
      ).items as Metric[];
      const current = this.store.get<Rule>('rule', rule.id, workspace);
      if (
        !current?.enabled ||
        JSON.stringify({ ...current, pendingSince: null }) !==
          JSON.stringify({ ...rule, pendingSince: null })
      )
        continue;
      const metric = samples.find((m) => m.name === rule.metric);
      const noData = !metric;
      const violated = noData
        ? rule.noData === 'alert'
        : rule.operator === 'gt'
          ? metric.value > rule.threshold
          : metric.value < rule.threshold;
      const active = this.store
        .alerts(workspace)
        .find((a) => a.ruleId === rule.id && a.status === 'firing');
      if (!violated) {
        if (active) {
          active.status = 'resolved';
          active.resolvedAt = now;
          this.store.put('alert', active);
          this.store.audit(workspace, 'worker', 'alert.resolved', active.id);
        }
        if (rule.pendingSince !== null) {
          rule.pendingSince = null;
          this.store.put('rule', rule);
        }
        continue;
      }
      if (active) {
        active.value = metric?.value ?? null;
        active.reason = noData ? 'no_data' : 'threshold';
        this.store.put('alert', active);
        continue;
      }
      if (rule.pendingSince === null) {
        rule.pendingSince = now;
        this.store.put('rule', rule);
      }
      if (now - rule.pendingSince! < rule.durationSec * 1000) continue;
      const alert: Alert = {
        id: randomUUID(),
        workspace,
        ruleId: rule.id,
        title: rule.name,
        service: metric?.service ?? rule.service,
        environment: rule.environment,
        severity: rule.severity,
        status: 'firing',
        reason: noData ? 'no_data' : 'threshold',
        value: metric?.value ?? null,
        createdAt: now,
        resolvedAt: null,
        acknowledged: false,
        snoozedUntil: 0,
      };
      this.store.transaction(() => {
        this.store.put('alert', alert);
        for (const channel of this.store
          .list<Channel>('channel', workspace)
          .filter((c) => c.enabled))
          this.store.db
            .prepare(
              'INSERT OR IGNORE INTO outbox(id,workspace,alert_id,channel_id,status,next_at,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(randomUUID(), workspace, alert.id, channel.id, 'pending', now, now);
        this.store.audit(workspace, 'worker', 'alert.firing', alert.id);
      });
    }
  }
  async deliver(now = Date.now()) {
    const jobs = this.store.db
      .prepare(
        "SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 10",
      )
      .all(now) as {
      id: string;
      workspace: Workspace;
      alert_id: string;
      channel_id: string;
      attempts: number;
    }[];
    for (const job of jobs) {
      const alert = this.store.get<Alert>('alert', job.alert_id, job.workspace),
        channel = this.store.get<Channel>('channel', job.channel_id, job.workspace);
      if (!alert || !channel || !channel.enabled || alert.status === 'resolved') {
        this.store.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(job.id);
        continue;
      }
      if (alert.snoozedUntil > now) {
        this.store.db
          .prepare('UPDATE outbox SET next_at=? WHERE id=?')
          .run(alert.snoozedUntil, job.id);
        continue;
      }
      try {
        const result = await this.send(decrypt(channel.encryptedUrl, this.key), {
          source: 'signaldesk',
          deliveryId: job.id,
          alert,
        });
        if (result.status < 200 || result.status >= 300)
          throw new Error(`Destination returned HTTP ${result.status}`);
        this.store.db
          .prepare(
            "UPDATE outbox SET status='delivered',attempts=attempts+1,delivered_at=?,error=NULL WHERE id=?",
          )
          .run(now, job.id);
      } catch (e) {
        const attempts = job.attempts + 1;
        this.store.db
          .prepare('UPDATE outbox SET status=?,attempts=?,next_at=?,error=? WHERE id=?')
          .run(
            attempts >= 5 ? 'failed' : 'pending',
            attempts,
            now + Math.min(300000, 5000 * 2 ** attempts),
            e instanceof Error ? e.message : 'Delivery failed',
            job.id,
          );
      }
    }
  }
  async probes(now = Date.now()) {
    for (const probe of this.store
      .list<Probe>('probe', 'live')
      .filter((p) => p.enabled && (!p.lastRun || now - p.lastRun >= 60000))
      .slice(0, 10)) {
      let up = 0,
        duration = 0;
      probe.lastDurationMs = null;
      try {
        const result = await this.send(probe.url);
        probe.lastStatus = result.status;
        duration = result.durationMs;
        probe.lastDurationMs = duration;
        up = result.status >= 200 && result.status < 300 ? 1 : 0;
        probe.lastError = null;
      } catch (e) {
        probe.lastStatus = null;
        probe.lastError = e instanceof Error ? e.message : 'Probe failed';
      }
      probe.lastRun = now;
      this.store.put('probe', probe);
      await this.telemetry.append('live', [
        {
          kind: 'metric',
          timestamp: now,
          service: probe.service,
          environment: probe.environment,
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
                name: 'probe_duration_ms' as const,
                value: duration,
              },
            ]
          : []),
      ]);
    }
  }
  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.telemetry.prune(now - 7 * 86400000);
      await this.probes(now);
      await this.evaluate('live', now);
      await this.deliver(now);
      this.heartbeat = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : 'Worker failed';
    } finally {
      this.running = false;
    }
  }
}
