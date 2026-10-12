import { randomUUID, createHash } from 'node:crypto';
import {
  dimensionKeys,
  type Alert,
  type DependencyMonitor,
  type Workspace,
} from '../../../packages/contracts/src/index.ts';
import type { Storage } from './storage.ts';
import type { TelemetryStore } from './store.ts';
import { notificationPlan } from './operations.ts';
import { flowKeys } from './flow-sql.ts';
/** Observed-attempt rules; not whole-traffic SLOs. Missing/insufficient evidence holds an active alert. */
export async function evaluateDependencies(
  store: Storage,
  telemetry: TelemetryStore,
  workspace: Workspace,
  now: number,
) {
  if (!telemetry.aggregate) return;
  for (const monitor of (
    await store.list<DependencyMonitor>('dependency-monitor', workspace)
  ).filter((m) => m.enabled)) {
    await store.withWorker('dependency:' + monitor.id, async () => {
      const results = await telemetry.aggregate!('flowEdges', {
        workspace,
        from: now - monitor.windowMinutes * 60000,
        to: now,
        service: monitor.service,
        environment: monitor.environment,
        ...Object.fromEntries(dimensionKeys.filter((k) => monitor[k]).map((k) => [k, monitor[k]])),
      });
      if (results.truncated)
        throw new Error('Dependency monitor coverage exceeds edge cap; narrow its scope');
      const rows = results.rows.filter(
        (r) =>
          r.direction === 'outbound' &&
          r.s_name === monitor.service &&
          r.t_name === monitor.dependency &&
          r.route === monitor.route &&
          r.method === monitor.method,
      );
      await store.withControl(async () => {
        const current = await store.get<DependencyMonitor>(
          'dependency-monitor',
          monitor.id,
          workspace,
        );
        if (!current?.enabled || current.revision !== monitor.revision) return;
        const active = await store.alerts(workspace, 'dependency:' + monitor.id);
        const observations = [];
        for (const row of rows) {
          const groupKey = createHash('sha256')
              .update(JSON.stringify(flowKeys.map((k) => String(row[k]))))
              .digest('hex')
              .slice(0, 24),
            count = Number(row.count),
            value =
              monitor.indicator === 'p95_ms'
                ? Number(row.p95_ms)
                : (Number(row.errors) / count) * 100;
          const status =
            count < monitor.minimumRequests
              ? 'unknown'
              : value > monitor.threshold
                ? 'violated'
                : 'healthy';
          observations.push({
            edge: groupKey,
            region: row.s_region,
            targetRegion: row.t_region,
            count,
            value,
            status,
          });
          let alert = active.find((a) => a.groupKey === groupKey);
          if (status === 'unknown') continue;
          if (status === 'violated') {
            const fresh = !alert;
            alert ??= {
              id: randomUUID(),
              workspace,
              ruleId: 'dependency:' + monitor.id,
              groupKey,
              title: monitor.name + ' · ' + monitor.dependency,
              service: monitor.service,
              environment: monitor.environment,
              region: String(row.s_region),
              module: String(row.s_module),
              dependency: monitor.dependency,
              dependencyRoute: monitor.route,
              severity: 'warning',
              status: 'firing',
              reason: 'threshold',
              value,
              createdAt: now,
              resolvedAt: null,
              acknowledged: false,
              snoozedUntil: 0,
              notificationSequence: 0,
            };
            alert.value = value;
            const plan = await notificationPlan(store, alert, now);
            const repeat =
              !fresh &&
              !alert.acknowledged &&
              alert.snoozedUntil <= now &&
              plan.channelIds.length &&
              (alert.lastNotifiedAt === undefined ||
                now - alert.lastNotifiedAt >= plan.repeatMinutes * 60000);
            if (fresh || repeat) {
              alert.lastNotifiedAt = plan.channelIds.length ? now : alert.lastNotifiedAt;
              if (repeat) alert.notificationSequence = (alert.notificationSequence ?? 0) + 1;
              await store.publishAlert(
                alert,
                plan.channelIds,
                repeat
                  ? {
                      key: alert.id + ':repeat:' + alert.notificationSequence,
                      type: 'repeat',
                      time: now,
                    }
                  : undefined,
              );
            } else await store.put('alert', alert);
          } else if (alert) {
            alert.status = 'resolved';
            alert.resolvedAt = now;
            const plan = await notificationPlan(store, alert, now, true);
            await store.publishAlert(alert, plan.channelIds, {
              key: alert.id + ':recovery',
              type: 'recovery',
              time: now,
            });
          }
        }
        await store.put('dependency-status', {
          id: monitor.id,
          workspace,
          at: now,
          revision: monitor.revision,
          observations,
          status: !rows.length
            ? 'unknown'
            : observations.some((o) => o.status === 'violated')
              ? 'violated'
              : observations.some((o) => o.status === 'unknown')
                ? 'unknown'
                : 'healthy',
        });
      });
    });
  }
}
