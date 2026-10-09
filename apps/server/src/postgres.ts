import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import {
  dimensionKeys,
  identity,
  resourceKey,
  type TelemetryEvent,
  type Workspace,
  type QueryScope,
  type Page,
  type Metric,
  type Alert,
  type Rule,
  type Incident,
} from '../../../packages/contracts/src/index.ts';
import { sanitize } from './store.ts';
import type { Storage, Delivery, ResourcePage } from './storage.ts';

// Session-bound workers require direct PostgreSQL or session-mode pooling.
// Every operation in the callback uses this same connection: a lost lock connection
// fails subsequent reads/writes instead of silently switching to an unfenced pool client.
export class PostgresStore implements Storage {
  readonly backend = 'postgres' as const;
  readonly pool: Pool;
  private context = new AsyncLocalStorage<{
    client: PoolClient;
    transaction: boolean;
    failure?: Error;
  }>();
  constructor(
    connectionString: string | undefined,
    readonly maxEvents = 1000000,
    poolSize = 10,
    readonly maxResources = 20000,
  ) {
    this.pool = new Pool({
      connectionString,
      max: poolSize,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
      application_name: 'signaldesk',
    });
    this.pool.on('error', () => {
      /* Idle clients are discarded by pg; active operations reject. */
    });
  }
  private async sql(text: string, values: unknown[] = []) {
    const context = this.context.getStore();
    if (context?.failure) throw context.failure;
    return (context?.client ?? this.pool).query(text, values);
  }
  private async transaction<T>(fn: () => Promise<T>) {
    const context = this.context.getStore();
    if (context?.transaction) return fn();
    const client = context?.client ?? (await this.pool.connect()),
      state = context ?? { client, transaction: false, failure: undefined as Error | undefined };
    const failed = (error: Error) => {
      state.failure = error;
    };
    if (!context) client.on('error', failed);
    try {
      await client.query('BEGIN');
      const result = await this.context.run({ ...state, transaction: true }, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (!context) {
        client.removeListener('error', failed);
        client.release(!!state.failure);
      }
    }
  }
  async withControl<T>(fn: () => Promise<T>) {
    return this.transaction(async () => {
      await this.sql("SELECT pg_advisory_xact_lock(hashtext('signaldesk-control'),0)");
      return fn();
    });
  }
  async withWorker(key: string, fn: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    let locked = false,
      broken = false;
    const state = { client, transaction: false, failure: undefined as Error | undefined },
      failed = (error: Error) => {
        state.failure = error;
        broken = true;
      };
    client.on('error', failed);
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtext('signaldesk-worker'),hashtext($1)) AS locked",
          [key],
        )
      ).rows[0].locked;
      if (!locked) return false;
      await this.context.run(state, fn);
      return true;
    } finally {
      if (locked)
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext('signaldesk-worker'),hashtext($1))",
            [key],
          );
        } catch {
          broken = true;
        }
      client.removeListener('error', failed);
      client.release(broken);
    }
  }
  async migrate() {
    await this.withControl(async () => {
      await this
        .sql(`CREATE TABLE IF NOT EXISTS migrations(version integer PRIMARY KEY,applied_at bigint NOT NULL);
        CREATE TABLE IF NOT EXISTS telemetry(id text NOT NULL,workspace text NOT NULL,kind text NOT NULL,time bigint NOT NULL,service text NOT NULL,environment text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(workspace,id));
        CREATE INDEX IF NOT EXISTS telemetry_retention ON telemetry(time);
        CREATE INDEX IF NOT EXISTS telemetry_scope ON telemetry(workspace,kind,time DESC,id DESC);
        CREATE INDEX IF NOT EXISTS telemetry_service ON telemetry(workspace,kind,service,environment,time DESC);
        CREATE INDEX IF NOT EXISTS telemetry_trace ON telemetry(workspace,kind,(data->>'traceId'),time DESC);
        CREATE INDEX IF NOT EXISTS telemetry_dimensions ON telemetry(workspace,kind,(data->>'region'),(data->>'module'),(data->>'instanceId'),time DESC);
        CREATE TABLE IF NOT EXISTS resources(id text NOT NULL,workspace text NOT NULL,first_seen bigint NOT NULL,last_seen bigint NOT NULL,retired boolean NOT NULL DEFAULT false,data jsonb NOT NULL,PRIMARY KEY(workspace,id));
        CREATE INDEX IF NOT EXISTS resources_scope ON resources(workspace,last_seen DESC,id DESC);
        CREATE INDEX IF NOT EXISTS resources_dimensions ON resources(workspace,(data->>'service'),(data->>'environment'),(data->>'region'),(data->>'module'));
        CREATE TABLE IF NOT EXISTS latest_metrics(workspace text NOT NULL,resource_id text NOT NULL,name text NOT NULL,time bigint NOT NULL,data jsonb NOT NULL,PRIMARY KEY(workspace,resource_id,name));
        CREATE INDEX IF NOT EXISTS latest_metrics_time ON latest_metrics(workspace,time DESC);
        CREATE TABLE IF NOT EXISTS entities(kind text NOT NULL,id text NOT NULL,workspace text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(kind,id));
        CREATE INDEX IF NOT EXISTS entities_scope ON entities(workspace,kind);
        CREATE INDEX IF NOT EXISTS alert_time ON entities(workspace,((data->>'createdAt')::bigint) DESC) WHERE kind='alert';
        CREATE INDEX IF NOT EXISTS entities_rule ON entities(kind,workspace,(data->>'ruleId'),(data->>'status'));
        CREATE UNIQUE INDEX IF NOT EXISTS active_alert_group ON entities(workspace,(data->>'ruleId'),coalesce(data->>'groupKey','unobserved')) WHERE kind='alert' AND data->>'status'='firing';
        CREATE TABLE IF NOT EXISTS outbox(id text PRIMARY KEY,workspace text NOT NULL,alert_id text NOT NULL,channel_id text NOT NULL,status text NOT NULL,attempts integer NOT NULL DEFAULT 0,next_at bigint NOT NULL,error text,created_at bigint NOT NULL,delivered_at bigint,UNIQUE(alert_id,channel_id));
        CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_at) WHERE status='pending';
        CREATE TABLE IF NOT EXISTS audit(id text PRIMARY KEY,workspace text NOT NULL,time bigint NOT NULL,actor text NOT NULL,action text NOT NULL,target text NOT NULL);
        CREATE TABLE IF NOT EXISTS settings(key text PRIMARY KEY,value text NOT NULL);
        CREATE TABLE IF NOT EXISTS telemetry_capacity(id integer PRIMARY KEY,count bigint NOT NULL);
        INSERT INTO telemetry_capacity SELECT 1,count(*) FROM telemetry ON CONFLICT DO NOTHING;
        INSERT INTO migrations VALUES(1,(extract(epoch FROM clock_timestamp())*1000)::bigint) ON CONFLICT DO NOTHING;`);
    });
  }
  async append(workspace: Workspace, events: TelemetryEvent[]) {
    const prepared = events.map((event) => {
      const clean = { ...sanitize(event), ...identity(event), id: event.id ?? randomUUID() };
      return {
        data: clean,
        resourceId: createHash('sha256').update(resourceKey(clean)).digest('hex'),
      };
    });
    return this.transaction(async () => {
      // Serialize capacity accounting, not the API or query tier. Duplicate batches consume zero capacity.
      await this.sql('SELECT count FROM telemetry_capacity WHERE id=1 FOR UPDATE');
      const inserted = await this.sql(
        `INSERT INTO telemetry(id,workspace,kind,time,service,environment,data)
        SELECT e->'data'->>'id',$1,e->'data'->>'kind',(e->'data'->>'timestamp')::bigint,e->'data'->>'service',e->'data'->>'environment',e->'data'
        FROM jsonb_array_elements($2::jsonb) e ON CONFLICT DO NOTHING RETURNING data`,
        [workspace, JSON.stringify(prepared)],
      );
      const accepted = inserted.rowCount ?? 0;
      const count = Number(
        (
          await this.sql(
            'UPDATE telemetry_capacity SET count=count+$1 WHERE id=1 RETURNING count',
            [accepted],
          )
        ).rows[0].count,
      );
      if (count > this.maxEvents)
        throw Object.assign(new Error('Telemetry capacity reached'), { statusCode: 507 });
      const acceptedRows = inserted.rows.map((r) => ({
        data: r.data as TelemetryEvent,
        resourceId: createHash('sha256').update(resourceKey(r.data)).digest('hex'),
      }));
      const resourceRows = new Map<string, (typeof acceptedRows)[number] & { firstSeen: number }>(),
        metrics = new Map<string, (typeof acceptedRows)[number]>();
      for (const row of acceptedRows) {
        const old = resourceRows.get(row.resourceId);
        resourceRows.set(row.resourceId, {
          ...(old && old.data.timestamp > row.data.timestamp ? old : row),
          firstSeen: Math.min(old?.firstSeen ?? row.data.timestamp, row.data.timestamp),
        });
        if (row.data.kind === 'metric') {
          const key = row.resourceId + ':' + row.data.name,
            prior = metrics.get(key);
          if (!prior || row.data.timestamp > prior.data.timestamp) metrics.set(key, row);
        }
      }
      if (resourceRows.size)
        await this.sql(
          `INSERT INTO resources(id,workspace,first_seen,last_seen,data)
        SELECT e->>'resourceId',$1,(e->>'firstSeen')::bigint,(e->'data'->>'timestamp')::bigint,e->'data'
        FROM jsonb_array_elements($2::jsonb) e ON CONFLICT(workspace,id) DO UPDATE SET first_seen=least(resources.first_seen,excluded.first_seen),last_seen=greatest(resources.last_seen,excluded.last_seen),data=CASE WHEN excluded.last_seen>=resources.last_seen THEN excluded.data ELSE resources.data END`,
          [workspace, JSON.stringify([...resourceRows.values()])],
        );
      if (metrics.size)
        await this.sql(
          `INSERT INTO latest_metrics(workspace,resource_id,name,time,data)
        SELECT $1,e->>'resourceId',e->'data'->>'name',(e->'data'->>'timestamp')::bigint,e->'data'
        FROM jsonb_array_elements($2::jsonb) e ON CONFLICT(workspace,resource_id,name) DO UPDATE SET time=excluded.time,data=excluded.data WHERE excluded.time>=latest_metrics.time`,
          [workspace, JSON.stringify([...metrics.values()])],
        );
      if (
        accepted &&
        Number(
          (await this.sql('SELECT count(*) AS n FROM resources WHERE workspace=$1', [workspace]))
            .rows[0].n,
        ) > this.maxResources
      )
        throw Object.assign(new Error('Resource cardinality capacity reached'), {
          statusCode: 507,
        });
      return accepted;
    });
  }
  private filter(scope: QueryScope, timeColumn: string, kind?: TelemetryEvent['kind']) {
    const values: unknown[] = [scope.workspace, scope.to],
      where = ['workspace=$1', `${timeColumn}<=$2`];
    const add = (expression: string, value: unknown) => {
      values.push(value);
      where.push(expression.replace('?', `$${values.length}`));
    };
    if (kind) {
      add('kind=?', kind);
      add(`${timeColumn}>=?`, scope.from);
    }
    for (const key of ['service', 'environment', ...dimensionKeys] as const)
      if (scope[key]) add(`data->>'${key}'=?`, scope[key]);
    return { where, values, add };
  }
  async query(kind: TelemetryEvent['kind'], scope: QueryScope): Promise<Page<TelemetryEvent>> {
    const { where, values, add } = this.filter(scope, 'time', kind),
      limit = Math.min(scope.limit ?? 1000, 10000);
    if (scope.search) add("position(lower(?) in lower(data->>'message'))>0", scope.search);
    if (scope.level) add("data->>'level'=?", scope.level);
    if (scope.traceId) add("data->>'traceId'=?", scope.traceId);
    if (scope.metric) add("data->>'name'=?", scope.metric);
    if (scope.cursor) {
      let time: unknown, id: unknown;
      try {
        [time, id] = JSON.parse(Buffer.from(scope.cursor, 'base64url').toString());
      } catch {
        throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
      }
      if (typeof time !== 'number' || !Number.isFinite(time) || typeof id !== 'string')
        throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
      values.push(time, id);
      where.push(`(time,id)<($${values.length - 1},$${values.length})`);
    }
    values.push(limit + 1);
    const rows = (
      await this.sql(
        `SELECT data,time,id FROM telemetry WHERE ${where.join(' AND ')} ORDER BY time DESC,id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const last = rows.slice(0, limit).at(-1),
      more = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((r) => r.data),
      truncated: more,
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify([Number(last.time), last.id])).toString('base64url')
          : null,
    };
  }
  async inventory(scope: QueryScope): Promise<ResourcePage> {
    const { where, values } = this.filter(scope, 'first_seen'),
      limit = Math.min(scope.limit ?? 1000, 10000);
    values.push(limit + 1);
    const rows = (
      await this.sql(
        `SELECT id,first_seen,last_seen,retired,data FROM resources WHERE ${where.join(' AND ')} ORDER BY last_seen DESC,id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return {
      items: rows.slice(0, limit).map((r) => ({
        ...identity(r.data),
        id: r.id,
        host: r.data.host,
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        retired: r.retired,
        requestRate: null,
        errorPct: null,
        latency: null,
        status: r.retired ? 'retired' : 'unknown',
      })),
      truncated: rows.length > limit,
      nextCursor: null,
    };
  }
  async latestMetrics(scope: QueryScope): Promise<Page<Metric>> {
    const { where, values, add } = this.filter(scope, 'time'),
      limit = Math.min(scope.limit ?? 10000, 10000);
    add('time>=?', scope.from);
    const historical = !!(
      await this.sql('SELECT 1 FROM latest_metrics WHERE workspace=$1 AND time>$2 LIMIT 1', [
        scope.workspace,
        scope.to,
      ])
    ).rowCount;
    if (scope.metric) add(historical ? "data->>'name'=?" : 'name=?', scope.metric);
    values.push(limit + 1);
    const partition = ['service', 'environment', ...dimensionKeys, 'name']
      .map((key) => `(data->>'${key}')`)
      .join(',');
    const text = historical
      ? `SELECT data FROM (SELECT DISTINCT ON(${partition}) data,time,id FROM telemetry WHERE kind='metric' AND ${where.join(' AND ')} ORDER BY ${partition},time DESC,id DESC) AS versions ORDER BY time DESC,id DESC LIMIT $${values.length}`
      : `SELECT data FROM latest_metrics WHERE ${where.join(' AND ')} ORDER BY time DESC,resource_id DESC,name LIMIT $${values.length}`;
    const rows = (await this.sql(text, values)).rows;
    return {
      items: rows.slice(0, limit).map((r) => r.data),
      truncated: rows.length > limit,
      nextCursor: null,
    };
  }
  async retireResource(id: string, workspace: Workspace, retired: boolean) {
    return !!(
      await this.sql('UPDATE resources SET retired=$1 WHERE id=$2 AND workspace=$3', [
        retired,
        id,
        workspace,
      ])
    ).rowCount;
  }
  async occupancy() {
    return Number(
      (await this.sql('SELECT count FROM telemetry_capacity WHERE id=1')).rows[0].count,
    );
  }
  async prune(before: number) {
    return this.transaction(async () => {
      await this.sql('SELECT count FROM telemetry_capacity WHERE id=1 FOR UPDATE');
      const result = await this.sql('DELETE FROM telemetry WHERE time<$1', [before]);
      await this.sql('UPDATE telemetry_capacity SET count=count-$1 WHERE id=1', [
        result.rowCount ?? 0,
      ]);
      await this.sql('DELETE FROM latest_metrics WHERE time<$1', [before]);
      return result.rowCount ?? 0;
    });
  }
  async list<T>(
    kind: string,
    workspace: Workspace,
    filter?: { ruleId?: string; activeOnly?: boolean },
  ): Promise<T[]> {
    return (
      await this.sql(
        `SELECT data FROM entities WHERE kind=$1 AND workspace=$2 ${filter?.ruleId ? "AND data->>'ruleId'=$3" : ''} ${filter?.activeOnly ? "AND data->>'status'='firing'" : ''}`,
        [kind, workspace, ...(filter?.ruleId ? [filter.ruleId] : [])],
      )
    ).rows.map((r) => r.data);
  }
  async get<T>(kind: string, id: string, workspace: Workspace): Promise<T | null> {
    return (
      (
        await this.sql('SELECT data FROM entities WHERE kind=$1 AND id=$2 AND workspace=$3', [
          kind,
          id,
          workspace,
        ])
      ).rows[0]?.data ?? null
    );
  }
  async put(kind: string, entity: { id: string; workspace: Workspace }) {
    await this.sql(
      'INSERT INTO entities VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE entities.workspace=excluded.workspace',
      [kind, entity.id, entity.workspace, JSON.stringify(entity)],
    );
  }
  async rules(workspace: Workspace) {
    return this.list<Rule>('rule', workspace);
  }
  async alerts(workspace: Workspace, ruleId?: string) {
    return (
      await this.list<Alert>('alert', workspace, ruleId ? { ruleId, activeOnly: true } : undefined)
    ).sort((a, b) => b.createdAt - a.createdAt);
  }
  async alertPage(scope: QueryScope): Promise<Page<Alert>> {
    const where = [
        "kind='alert'",
        'workspace=$1',
        "(data->>'createdAt')::bigint<=$2",
        "(data->>'status'='firing' OR coalesce(data->>'resolvedAt',data->>'createdAt')::bigint>=$3)",
      ],
      values: unknown[] = [scope.workspace, scope.to, scope.from];
    for (const key of ['service', 'environment', ...dimensionKeys] as const)
      if (scope[key]) {
        values.push(scope[key]);
        where.push(`(data->>'${key}' IS NULL OR data->>'${key}'=$${values.length})`);
      }
    const rows = (
      await this.sql(
        `SELECT data FROM entities WHERE ${where.join(' AND ')} ORDER BY (data->>'createdAt')::bigint DESC LIMIT 1001`,
        values,
      )
    ).rows;
    return {
      items: rows.slice(0, 1000).map((r) => r.data),
      truncated: rows.length > 1000,
      nextCursor: null,
    };
  }
  async incidents(workspace: Workspace) {
    return (await this.list<Incident>('incident', workspace)).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  async setting(key: string) {
    return (
      (await this.sql('SELECT value FROM settings WHERE key=$1', [key])).rows[0]?.value ?? null
    );
  }
  async setSetting(key: string, value: string) {
    await this.sql(
      'INSERT INTO settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, value],
    );
  }
  async audit(workspace: Workspace, actor: string, action: string, target: string) {
    await this.sql('INSERT INTO audit VALUES($1,$2,$3,$4,$5,$6)', [
      randomUUID(),
      workspace,
      Date.now(),
      actor,
      action,
      target,
    ]);
  }
  async auditTrail(workspace: Workspace) {
    return (
      await this.sql(
        'SELECT time,actor,action,target FROM audit WHERE workspace=$1 ORDER BY time DESC LIMIT 100',
        [workspace],
      )
    ).rows.map((r) => ({ ...r, time: Number(r.time) }));
  }
  async deliveries(workspace?: Workspace, dueAt?: number): Promise<Delivery[]> {
    const values: unknown[] = [],
      where = ['1=1'];
    if (workspace) {
      values.push(workspace);
      where.push(`workspace=$${values.length}`);
    }
    if (dueAt !== undefined) {
      values.push(dueAt);
      where.push(`status='pending' AND next_at<=$${values.length}`);
    }
    const rows = (
      await this.sql(
        `SELECT * FROM outbox WHERE ${where.join(' AND ')} ORDER BY next_at LIMIT ${dueAt !== undefined ? 10 : 100}`,
        values,
      )
    ).rows;
    return rows.map((r) => ({
      ...r,
      next_at: Number(r.next_at),
      created_at: Number(r.created_at),
      delivered_at: r.delivered_at === null ? null : Number(r.delivered_at),
    }));
  }
  async updateDelivery(
    id: string,
    patch: Partial<Omit<Delivery, 'id' | 'workspace' | 'alert_id' | 'channel_id'>>,
  ) {
    const entries = Object.entries(patch).filter(([key]) =>
      ['status', 'attempts', 'next_at', 'created_at', 'delivered_at', 'error'].includes(key),
    );
    if (entries.length)
      await this.sql(
        `UPDATE outbox SET ${entries.map(([key], i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${entries.length + 1}`,
        [...entries.map(([, v]) => v), id],
      );
  }
  async retryDelivery(id: string, workspace: Workspace, now: number) {
    return !!(
      await this.sql(
        "UPDATE outbox SET status='pending',attempts=0,next_at=$1 WHERE id=$2 AND workspace=$3 AND status='failed'",
        [now, id, workspace],
      )
    ).rowCount;
  }
  async publishAlert(alert: Alert, channelIds: string[]) {
    await this.withControl(async () => {
      await this.put('alert', alert);
      for (const channelId of channelIds)
        await this.sql(
          "INSERT INTO outbox(id,workspace,alert_id,channel_id,status,next_at,created_at) VALUES($1,$2,$3,$4,'pending',$5,$5) ON CONFLICT DO NOTHING",
          [randomUUID(), alert.workspace, alert.id, channelId, alert.createdAt],
        );
      await this.audit(alert.workspace, 'worker', 'alert.firing', alert.id);
    });
  }
  async close() {
    await this.pool.end();
  }
}
