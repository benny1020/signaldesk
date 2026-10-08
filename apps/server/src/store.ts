import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  TelemetryEvent,
  QueryScope,
  Page,
  Rule,
  Alert,
  Incident,
  Workspace,
} from '../../../packages/contracts/src/index.ts';

export interface TelemetryStore {
  append(workspace: Workspace, events: TelemetryEvent[]): number | Promise<number>;
  query(
    kind: TelemetryEvent['kind'],
    scope: QueryScope,
  ): Page<TelemetryEvent> | Promise<Page<TelemetryEvent>>;
  occupancy(): number | Promise<number>;
  prune(before: number): number | Promise<number>;
}
const forbidden =
  /authorization|password|secret|token(?!s)|api.?key|prompt|completion|input.messages|output.messages|system.instructions|tool.call.(arguments|result)/i;
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
export class Store implements TelemetryStore {
  db: DatabaseSync;
  constructor(
    path: string,
    readonly maxEvents = 1000000,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1,unixepoch()*1000);
      CREATE TABLE IF NOT EXISTS telemetry(id TEXT NOT NULL,workspace TEXT NOT NULL,kind TEXT NOT NULL,time INTEGER NOT NULL,service TEXT NOT NULL,environment TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,id));
      CREATE INDEX IF NOT EXISTS telemetry_scope ON telemetry(workspace,kind,time DESC,id DESC);
      CREATE INDEX IF NOT EXISTS telemetry_service ON telemetry(workspace,kind,service,environment,time DESC);
      CREATE INDEX IF NOT EXISTS telemetry_trace ON telemetry(workspace,kind,json_extract(data,'$.traceId'),time DESC);
      CREATE INDEX IF NOT EXISTS telemetry_metric ON telemetry(workspace,kind,service,environment,json_extract(data,'$.name'),time DESC);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,workspace TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entities_scope ON entities(workspace,kind);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,alert_id TEXT NOT NULL,channel_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,error TEXT,created_at INTEGER NOT NULL,delivered_at INTEGER,UNIQUE(alert_id,channel_id));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,time INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
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
        const clean = { ...sanitize(event), id: event.id ?? randomUUID() };
        return (
          count +
          Number(
            insert.run(
              clean.id,
              workspace,
              clean.kind,
              clean.timestamp,
              clean.service,
              clean.environment,
              JSON.stringify(clean),
            ).changes,
          )
        );
      }, 0);
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
      const [time, id] = JSON.parse(Buffer.from(scope.cursor, 'base64url').toString());
      if (!Number.isFinite(time) || typeof id !== 'string') throw new Error('Invalid cursor');
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
  occupancy() {
    return Number(
      (this.db.prepare('SELECT count(*) AS n FROM telemetry').get() as { n: number }).n,
    );
  }
  prune(before: number) {
    return Number(this.db.prepare('DELETE FROM telemetry WHERE time<?').run(before).changes);
  }
  list<T>(kind: string, workspace: Workspace): T[] {
    return (
      this.db
        .prepare('SELECT data FROM entities WHERE kind=? AND workspace=?')
        .all(kind, workspace) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(kind: string, id: string, workspace: Workspace): T | null {
    const r = this.db
      .prepare('SELECT data FROM entities WHERE kind=? AND id=? AND workspace=?')
      .get(kind, id, workspace) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  }
  put(kind: string, entity: { id: string; workspace: Workspace }) {
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
  alerts(workspace: Workspace) {
    return this.list<Alert>('alert', workspace).sort((a, b) => b.createdAt - a.createdAt);
  }
  incidents(workspace: Workspace) {
    return this.list<Incident>('incident', workspace).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  close() {
    this.db.close();
  }
}
