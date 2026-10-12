import { aggregateSQL } from './aggregate.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { identity, resourceKey, dimensionKeys } from '../../../packages/contracts/src/index.ts';
import type { ControlStore, Delivery, ResourcePage } from './storage.ts';
import type {
  TelemetryEvent,
  QueryScope,
  Page,
  Rule,
  Alert,
  Incident,
  Workspace,
  Metric,
} from '../../../packages/contracts/src/index.ts';

export interface TelemetryStore {
  aggregate?(
    kind: import('../../../packages/contracts/src/index.ts').AggregateKind,
    scope: QueryScope & { route?: string; latencyMs?: number },
  ):
    | import('../../../packages/contracts/src/index.ts').AggregateResult
    | Promise<import('../../../packages/contracts/src/index.ts').AggregateResult>;
  append(workspace: Workspace, events: TelemetryEvent[]): number | Promise<number>;
  query(
    kind: TelemetryEvent['kind'],
    scope: QueryScope,
  ): Page<TelemetryEvent> | Promise<Page<TelemetryEvent>>;
  occupancy(): number | Promise<number>;
  prune(before: number): number | Promise<number>;
  inventory?(scope: QueryScope): ResourcePage | Promise<ResourcePage>;
  latestMetrics?(scope: QueryScope): Page<Metric> | Promise<Page<Metric>>;
}
const forbidden =
  /authorization|password|secret|token(?!s)|api.?key|prompt|completion|input.messages|output.messages|system.instructions|tool.call.(arguments|result)|cookie|baggage|http\.(request|response)\.(header|body)|^url\.(full|query|path)$|^http\.(url|target)$/i;
export function redact(text: string): string {
  return text
    .replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
    .replace(/((?:password|api[_-]?key|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
}
export function sanitize(event: TelemetryEvent): TelemetryEvent {
  if (event.kind === 'metric') return event;
  const attributes = Object.fromEntries(
    Object.entries(event.attributes)
      .filter(([k]) => !forbidden.test(k))
      .map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]),
  );
  return {
    ...event,
    attributes,
    ...(event.kind === 'log' ? { message: redact(event.message) } : {}),
  };
}
export class Store implements TelemetryStore, ControlStore {
  readonly backend = 'sqlite' as const;
  private controlTail: Promise<unknown> = Promise.resolve();
  private workerLocks = new Set<string>();
  db: DatabaseSync;
  constructor(
    path: string,
    readonly maxEvents = 1000000,
    readonly maxResources = 20000,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1,unixepoch()*1000);
      CREATE TABLE IF NOT EXISTS telemetry(id TEXT NOT NULL,workspace TEXT NOT NULL,kind TEXT NOT NULL,time INTEGER NOT NULL,service TEXT NOT NULL,environment TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,id));
      CREATE INDEX IF NOT EXISTS telemetry_retention ON telemetry(time);
      CREATE INDEX IF NOT EXISTS telemetry_scope ON telemetry(workspace,kind,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS telemetry_service ON telemetry(workspace,kind,service,environment,time DESC);
      CREATE INDEX IF NOT EXISTS telemetry_trace ON telemetry(workspace,kind,json_extract(data,'$.traceId'),time DESC);
      CREATE INDEX IF NOT EXISTS telemetry_metric ON telemetry(workspace,kind,service,environment,json_extract(data,'$.name'),time DESC);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,workspace TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entities_scope ON entities(workspace,kind);
      CREATE INDEX IF NOT EXISTS alert_time ON entities(workspace,json_extract(data,'$.createdAt') DESC) WHERE kind='alert';
      CREATE INDEX IF NOT EXISTS entities_rule ON entities(kind,workspace,json_extract(data,'$.ruleId'),json_extract(data,'$.status'));
      CREATE UNIQUE INDEX IF NOT EXISTS active_alert_group ON entities(workspace,json_extract(data,'$.ruleId'),coalesce(json_extract(data,'$.groupKey'),'unobserved')) WHERE kind='alert' AND json_extract(data,'$.status')='firing';
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,alert_id TEXT NOT NULL,channel_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,error TEXT,created_at INTEGER NOT NULL,delivered_at INTEGER,UNIQUE(alert_id,channel_id));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,time INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resources(id TEXT NOT NULL,workspace TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,retired INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,PRIMARY KEY(workspace,id));
      CREATE INDEX IF NOT EXISTS resources_scope ON resources(workspace,last_seen DESC,id DESC);
      CREATE TABLE IF NOT EXISTS latest_metrics(workspace TEXT NOT NULL,resource_id TEXT NOT NULL,name TEXT NOT NULL,time INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,resource_id,name));
      CREATE INDEX IF NOT EXISTS latest_metrics_time ON latest_metrics(workspace,time DESC);`);
    if (!this.db.prepare('SELECT version FROM migrations WHERE version=3').get()) {
      this.transaction(() =>
        this.db.exec(`ALTER TABLE outbox RENAME TO outbox_v2;
        CREATE TABLE outbox(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,alert_id TEXT NOT NULL,channel_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,error TEXT,created_at INTEGER NOT NULL,delivered_at INTEGER,event_key TEXT NOT NULL,event_type TEXT NOT NULL,UNIQUE(event_key,channel_id));
        INSERT INTO outbox SELECT *,alert_id,'firing' FROM outbox_v2;
        DROP TABLE outbox_v2;
        CREATE INDEX outbox_due ON outbox(next_at) WHERE status='pending';
        INSERT INTO migrations VALUES(3,unixepoch()*1000);`),
      );
    }
    if (!this.db.prepare('SELECT version FROM migrations WHERE version=2').get()) {
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT workspace,data FROM telemetry').all() as {
          workspace: Workspace;
          data: string;
        }[])
          this.indexResource(row.workspace, JSON.parse(row.data));
        this.db.prepare('INSERT INTO migrations VALUES(2,?)').run(Date.now());
      });
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  append(workspace: Workspace, events: TelemetryEvent[]): number {
    const insert = this.db.prepare('INSERT OR IGNORE INTO telemetry VALUES(?,?,?,?,?,?,?)');
    return this.transaction(() => {
      const accepted = events.reduce((count, event) => {
        const clean = { ...sanitize(event), ...identity(event), id: event.id ?? randomUUID() };
        const changed = Number(
          insert.run(
            clean.id,
            workspace,
            clean.kind,
            clean.timestamp,
            clean.service,
            clean.environment,
            JSON.stringify(clean),
          ).changes,
        );
        if (changed) this.indexResource(workspace, clean);
        return count + changed;
      }, 0);
      if (
        accepted &&
        Number(
          (
            this.db
              .prepare('SELECT count(*) AS n FROM resources WHERE workspace=?')
              .get(workspace) as { n: number }
          ).n,
        ) > this.maxResources
      )
        throw Object.assign(new Error('Resource cardinality capacity reached'), {
          statusCode: 507,
        });
      if (this.occupancy() > this.maxEvents)
        throw Object.assign(
          new Error(
            'Telemetry capacity reached. Reduce retention or configure a larger storage adapter.',
          ),
          { statusCode: 507 },
        );
      return accepted;
    });
  }
  query(kind: TelemetryEvent['kind'], scope: QueryScope): Page<TelemetryEvent> {
    const limit = Math.min(scope.limit ?? 1000, 10000);
    const where = ['workspace=?', 'kind=?', 'time>=?', 'time<=?'];
    const args: (string | number)[] = [scope.workspace, kind, scope.from, scope.to];
    if (scope.service) {
      where.push('service=?');
      args.push(scope.service);
    }
    if (scope.environment) {
      where.push('environment=?');
      args.push(scope.environment);
    }
    for (const key of dimensionKeys)
      if (scope[key]) {
        where.push(`coalesce(json_extract(data,'$.${key}'),'unknown')=?`);
        args.push(scope[key]!);
      }
    if (scope.eventId) {
      where.push('id=?');
      args.push(scope.eventId);
    }
    if (scope.route && kind === 'span') {
      where.push(
        "coalesce(json_extract(data,'$.attributes.\"http.route\"'),json_extract(data,'$.name'))=?",
      );
      args.push(scope.route);
    }
    if (scope.search) {
      where.push("instr(lower(json_extract(data,'$.message')),lower(?))>0");
      args.push(scope.search);
    }
    if (scope.level) {
      where.push("json_extract(data,'$.level')=?");
      args.push(scope.level);
    }
    if (scope.traceId) {
      where.push("json_extract(data,'$.traceId')=?");
      args.push(scope.traceId);
    }
    if (scope.metric) {
      where.push("json_extract(data,'$.name')=?");
      args.push(scope.metric);
    }
    if (scope.cursor) {
      let time: unknown, id: unknown;
      try {
        [time, id] = JSON.parse(Buffer.from(scope.cursor, 'base64url').toString());
      } catch {
        throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
      }
      if (typeof time !== 'number' || !Number.isFinite(time) || typeof id !== 'string')
        throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
      where.push('(time<? OR (time=? AND id<?))');
      args.push(time, time, id);
    }
    const rows = this.db
      .prepare(
        `SELECT data,time,id FROM telemetry WHERE ${where.join(' AND ')} ORDER BY time DESC,id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as { data: string; time: number; id: string }[];
    const more = rows.length > limit,
      selected = rows.slice(0, limit),
      last = selected.at(-1);
    return {
      items: selected.map((r) => JSON.parse(r.data)),
      truncated: more,
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify([last.time, last.id])).toString('base64url')
          : null,
    };
  }
  aggregate(
    kind: import('../../../packages/contracts/src/index.ts').AggregateKind,
    scope: QueryScope & { route?: string; latencyMs?: number },
  ) {
    const { sql, values, stepMs } = aggregateSQL(kind, scope, false);
    const rows = this.db.prepare(sql).all(...(values as (string | number)[])) as Record<
      string,
      string | number | null
    >[];
    return {
      rows: rows.slice(0, 1000),
      truncated: rows.length > 1000,
      from: scope.from,
      to: scope.to,
      stepMs,
      source: 'retained-telemetry-sql' as const,
    };
  }
  occupancy() {
    return Number(
      (this.db.prepare('SELECT count(*) AS n FROM telemetry').get() as { n: number }).n,
    );
  }
  prune(before: number) {
    this.db.prepare('DELETE FROM latest_metrics WHERE time<?').run(before);
    return Number(this.db.prepare('DELETE FROM telemetry WHERE time<?').run(before).changes);
  }
  list<T>(
    kind: string,
    workspace: Workspace,
    filter?: { ruleId?: string; activeOnly?: boolean },
  ): T[] {
    return (
      this.db
        .prepare(
          `SELECT data FROM entities WHERE kind=? AND workspace=? ${filter?.ruleId ? "AND json_extract(data,'$.ruleId')=?" : ''} ${filter?.activeOnly ? "AND json_extract(data,'$.status')='firing'" : ''}`,
        )
        .all(kind, workspace, ...(filter?.ruleId ? [filter.ruleId] : [])) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(kind: string, id: string, workspace: Workspace): T | null {
    const r = this.db
      .prepare('SELECT data FROM entities WHERE kind=? AND id=? AND workspace=?')
      .get(kind, id, workspace) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  put<T extends { id: string; workspace: Workspace }>(kind: string, entity: T) {
    this.db
      .prepare(
        'INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE entities.workspace=excluded.workspace',
      )
      .run(kind, entity.id, entity.workspace, JSON.stringify(entity));
  }
  audit(workspace: Workspace, actor: string, action: string, target: string) {
    this.db
      .prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), workspace, Date.now(), actor, action, target);
  }
  rules(workspace: Workspace) {
    return this.list<Rule>('rule', workspace);
  }
  alerts(workspace: Workspace, ruleId?: string) {
    return this.list<Alert>(
      'alert',
      workspace,
      ruleId ? { ruleId, activeOnly: true } : undefined,
    ).sort((a, b) => b.createdAt - a.createdAt);
  }
  alertPage(scope: QueryScope): Page<Alert> {
    const where = [
        "kind='alert'",
        'workspace=?',
        "json_extract(data,'$.createdAt')<=?",
        "(json_extract(data,'$.status')='firing' OR coalesce(json_extract(data,'$.resolvedAt'),json_extract(data,'$.createdAt'))>=?)",
      ],
      args: (string | number)[] = [scope.workspace, scope.to, scope.from];
    for (const key of ['service', 'environment', ...dimensionKeys] as const)
      if (scope[key]) {
        where.push(`(json_extract(data,'$.${key}') IS NULL OR json_extract(data,'$.${key}')=?)`);
        args.push(scope[key]!);
      }
    const rows = this.db
      .prepare(
        `SELECT data FROM entities WHERE ${where.join(' AND ')} ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 1001`,
      )
      .all(...args) as { data: string }[];
    return {
      items: rows.slice(0, 1000).map((r) => JSON.parse(r.data)),
      truncated: rows.length > 1000,
      nextCursor: null,
    };
  }
  incidents(workspace: Workspace) {
    return this.list<Incident>('incident', workspace).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private indexResource(workspace: Workspace, event: TelemetryEvent) {
    const resource = identity(event),
      id = createHash('sha256').update(resourceKey(event)).digest('hex');
    this.db
      .prepare(
        `INSERT INTO resources(id,workspace,first_seen,last_seen,data) VALUES(?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen),data=json_set(CASE WHEN excluded.last_seen>=last_seen THEN excluded.data ELSE data END,'$.observedApplication',coalesce(json_extract(data,'$.observedApplication'),0) OR json_extract(excluded.data,'$.observedApplication'))`,
      )
      .run(
        id,
        workspace,
        event.timestamp,
        event.timestamp,
        JSON.stringify({
          ...resource,
          id,
          host: event.host,
          observedApplication:
            event.kind !== 'metric' || !['cpu_pct', 'memory_pct'].includes(event.name),
        }),
      );
    if (event.kind === 'metric')
      this.db
        .prepare(
          `INSERT INTO latest_metrics VALUES(?,?,?,?,?) ON CONFLICT(workspace,resource_id,name) DO UPDATE SET time=excluded.time,data=excluded.data WHERE excluded.time>=latest_metrics.time`,
        )
        .run(workspace, id, event.name, event.timestamp, JSON.stringify({ ...event, ...resource }));
  }
  private resourceFilter(scope: QueryScope, timeColumn: string) {
    const where = ['workspace=?', `${timeColumn}<=?`],
      args: (string | number)[] = [scope.workspace, scope.to];
    for (const key of ['service', 'environment', ...dimensionKeys] as const)
      if (scope[key]) {
        where.push(`json_extract(data,'$.${key}')=?`);
        args.push(scope[key]!);
      }
    return { where, args };
  }
  inventory(scope: QueryScope): ResourcePage {
    const { where, args } = this.resourceFilter(scope, 'first_seen'),
      limit = Math.min(scope.limit ?? 1000, 10000);
    const rows = this.db
      .prepare(
        `SELECT * FROM resources WHERE ${where.join(' AND ')} ORDER BY last_seen DESC,id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as {
      data: string;
      first_seen: number;
      last_seen: number;
      retired: number;
    }[];
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...JSON.parse(r.data),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        retired: !!r.retired,
        requestRate: null,
        errorPct: null,
        latency: null,
        status: r.retired ? 'retired' : 'unknown',
      })),
      truncated: rows.length > limit,
      nextCursor: null,
    };
  }
  latestMetrics(scope: QueryScope): Page<Metric> {
    const { where, args } = this.resourceFilter(scope, 'time'),
      limit = Math.min(scope.limit ?? 10000, 10000);
    where.push('time>=?');
    args.push(scope.from);
    const historical = !!this.db
      .prepare('SELECT 1 FROM latest_metrics WHERE workspace=? AND time>? LIMIT 1')
      .get(scope.workspace, scope.to);
    if (scope.metric) {
      where.push(historical ? "json_extract(data,'$.name')=?" : 'name=?');
      args.push(scope.metric);
    }
    const partition = ['service', 'environment', ...dimensionKeys, 'name']
      .map((key) => `coalesce(json_extract(data,'$.${key}'),'unknown')`)
      .join(',');
    const sql = historical
      ? `SELECT data FROM (SELECT data,time,id,row_number() OVER(PARTITION BY ${partition} ORDER BY time DESC,id DESC) AS rownum FROM telemetry WHERE kind='metric' AND ${where.join(' AND ')}) WHERE rownum=1 ORDER BY time DESC,id DESC LIMIT ?`
      : `SELECT data FROM latest_metrics WHERE ${where.join(' AND ')} ORDER BY time DESC,resource_id DESC,name LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit + 1) as { data: string }[];
    return {
      items: rows.slice(0, limit).map((r) => JSON.parse(r.data)),
      truncated: rows.length > limit,
      nextCursor: null,
    };
  }
  retireResource(id: string, workspace: Workspace, retired: boolean) {
    return !!this.db
      .prepare('UPDATE resources SET retired=? WHERE id=? AND workspace=?')
      .run(Number(retired), id, workspace).changes;
  }
  setting(key: string) {
    return (
      (
        this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  auditTrail(workspace: Workspace) {
    return this.db
      .prepare(
        'SELECT time,actor,action,target FROM audit WHERE workspace=? ORDER BY time DESC LIMIT 100',
      )
      .all(workspace);
  }
  deliveryStats(workspace: Workspace) {
    const rows = this.db
      .prepare(
        'SELECT status,count(*) AS n,min(created_at) AS oldest FROM outbox WHERE workspace=? GROUP BY status',
      )
      .all(workspace) as { status: string; n: number; oldest: number }[];
    return {
      pending: rows.find((r) => r.status === 'pending')?.n ?? 0,
      failed: rows.find((r) => r.status === 'failed')?.n ?? 0,
      delivered: rows.find((r) => r.status === 'delivered')?.n ?? 0,
      oldestPendingAt: rows.find((r) => r.status === 'pending')?.oldest ?? null,
    };
  }
  deliveries(workspace?: Workspace, dueAt?: number): Delivery[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox WHERE ${workspace ? 'workspace=?' : '1=1'} ${dueAt !== undefined ? "AND status='pending' AND next_at<=?" : ''} ORDER BY created_at DESC LIMIT ${dueAt !== undefined ? 10 : 100}`,
      )
      .all(
        ...(workspace ? [workspace] : []),
        ...(dueAt !== undefined ? [dueAt] : []),
      ) as Delivery[];
  }
  updateDelivery(
    id: string,
    patch: Partial<Omit<Delivery, 'id' | 'workspace' | 'alert_id' | 'channel_id'>>,
  ) {
    const entries = Object.entries(patch).filter(([key]) =>
      ['status', 'attempts', 'next_at', 'created_at', 'delivered_at', 'error'].includes(key),
    );
    if (entries.length)
      this.db
        .prepare(`UPDATE outbox SET ${entries.map(([k]) => `${k}=?`).join(',')} WHERE id=?`)
        .run(...entries.map(([, v]) => v ?? null), id);
  }
  retryDelivery(id: string, workspace: Workspace, now: number) {
    return !!this.db
      .prepare(
        "UPDATE outbox SET status='pending',attempts=0,next_at=? WHERE id=? AND workspace=? AND status='failed'",
      )
      .run(now, id, workspace).changes;
  }
  publishAlert(
    alert: Alert,
    channelIds: string[],
    notification = {
      key: alert.id,
      type: 'firing' as Delivery['event_type'],
      time: alert.createdAt,
    },
  ) {
    this.transaction(() => {
      this.put('alert', alert);
      for (const channelId of channelIds)
        this.db
          .prepare(
            'INSERT OR IGNORE INTO outbox(id,workspace,alert_id,channel_id,status,next_at,created_at,event_key,event_type) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            alert.workspace,
            alert.id,
            channelId,
            'pending',
            notification.time,
            notification.time,
            notification.key,
            notification.type,
          );
      this.audit(alert.workspace, 'worker', 'alert.' + notification.type, alert.id);
    });
  }
  async withControl<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.controlTail;
    let release!: () => void;
    this.controlTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async withWorker(key: string, fn: () => Promise<void>): Promise<boolean> {
    if (this.workerLocks.has(key)) return false;
    this.workerLocks.add(key);
    try {
      await fn();
      return true;
    } finally {
      this.workerLocks.delete(key);
    }
  }
  close() {
    this.db.close();
  }
}
