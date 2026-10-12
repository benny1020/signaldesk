import {
  dimensionKeys,
  type QueryScope,
  type AggregateKind,
} from '../../../packages/contracts/src/index.ts';
export const durationBounds = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const flowKeys = [
  's_type',
  's_name',
  's_env',
  's_region',
  's_module',
  't_type',
  't_name',
  't_env',
  't_region',
  't_module',
  'route',
  'method',
  'protocol',
] as const;
/** Deduplicate span identity, pair both sides once, retain caller-side measurements.
 * Context lookups intentionally ignore resource filters, but never cross workspace/environment.
 * Ancestry is bounded to 16 hops; missing context is unknown, never a fabricated customer outcome. */
export function flowSQL(kind: AggregateKind, scope: QueryScope, postgres: boolean) {
  const values: unknown[] = [];
  const p = (v: unknown) => {
    values.push(v);
    return postgres ? '$' + values.length : '?' + values.length;
  };
  const f = (key: string) => (postgres ? `(data->>'${key}')` : `json_extract(data,'$.${key}')`);
  const a = (key: string) =>
    postgres ? `(data->'attributes'->>'${key}')` : `json_extract(data,'$.attributes."${key}"')`;
  const n = (expr: string) => `CAST(${expr} AS ${postgres ? 'double precision' : 'REAL'})`;
  const code = `coalesce(${a('http.response.status_code')},${a('http.status_code')})`;
  const validCode = postgres
    ? `${code} ~ '^[0-9]{3}$'`
    : `CAST(${code} AS TEXT) GLOB '[0-9][0-9][0-9]'`;
  const resend = a('http.request.resend_count');
  const validResend = postgres
    ? `${resend} ~ '^[0-9]{1,9}$'`
    : `CAST(${resend} AS TEXT) <> '' AND CAST(${resend} AS TEXT) NOT GLOB '*[^0-9]*'`;
  const address = `CASE WHEN ${a('server.address')} IS NOT NULL THEN CAST(${a('server.address')} AS TEXT) || CASE WHEN coalesce(CAST(${a('server.port')} AS TEXT),'') NOT IN ('','80','443') THEN ':' || CAST(${a('server.port')} AS TEXT) ELSE '' END ELSE NULL END`;
  const stepMs = Math.max(60000, Math.ceil((scope.to - scope.from) / 48 / 60000) * 60000);
  const own = ['service', 'environment', ...dimensionKeys]
    .map((k) => `coalesce(${f(k)},'unknown') AS ${k}`)
    .join(',');
  const raw = `SELECT id,time,${own},${f('traceId')} AS trace_id,${f('spanId')} AS span_id,coalesce(${f('parentSpanId')},'') AS parent_id,
    lower(coalesce(${f('spanKind')},${a('span.kind')},'unknown')) AS span_kind,
    ${n(f('durationMs'))} AS duration,${f('status')} AS status,
    CASE WHEN ${validCode} THEN CAST(${code} AS integer) ELSE NULL END AS status_code,
    coalesce(${a('http.route')},${a('url.template')},${a('rpc.method')},${f('name')},'unknown') AS route,
    coalesce(${a('http.request.method')},${a('http.method')},'unknown') AS method,
    coalesce(${a('peer.service')},${address},${a('net.peer.name')},${a('db.namespace')},${a('db.system.name')},${a('db.system')},'unknown dependency') AS peer,
    coalesce(${a('signaldesk.caller')},'미계측 호출자') AS caller,
    ${a('error.type')} AS error_type,CASE WHEN CAST(${a('signaldesk.entry')} AS TEXT) IN ('true','1') THEN 1 ELSE 0 END AS is_entry,
    CASE WHEN ${validResend} THEN ${n(resend)} ELSE 0 END AS resend,
    CASE WHEN coalesce(${a('db.system.name')},${a('db.system')}) IS NOT NULL THEN 'database' WHEN ${a('rpc.system')} IS NOT NULL THEN 'rpc' ELSE 'http' END AS protocol,
    row_number() OVER(PARTITION BY ${f('traceId')},${f('spanId')},${f('environment')} ORDER BY time DESC,id DESC) AS duplicate_rank
    FROM telemetry WHERE workspace=${p(scope.workspace)} AND kind='span' AND time>=${p(Math.max(0, scope.from - 86400000))} AND time<=${p(scope.to + 86400000)}`;
  const selectedConditions = [`time>=${p(scope.from)}`, `time<=${p(scope.to)}`];
  for (const key of ['service', 'environment', ...dimensionKeys] as const)
    if (scope[key]) selectedConditions.push(`${key}=${p(scope[key])}`);
  if (scope.route) selectedConditions.push(`route=${p(scope.route)}`);
  const bad = (alias: string) =>
    `(${alias}.status='error' OR ${alias}.status_code>=500 OR (${alias}.span_kind='client' AND ${alias}.status_code>=400))`;
  const keyCols = flowKeys.join(',');
  // If erroneous telemetry contains two receivers, choose deterministically rather than multiply CLIENT attempts.
  const receiver = `LEFT JOIN receivers receiver ON receiver.trace_id=c.trace_id AND receiver.environment=c.environment AND receiver.parent_id=c.span_id AND receiver.receiver_rank=1`;
  const clientKeys: Record<(typeof flowKeys)[number], string> = {
    s_type: "'workload'",
    s_name: 'c.service',
    s_env: 'c.environment',
    s_region: 'c.region',
    s_module: 'c.module',
    t_type: "CASE WHEN receiver.span_id IS NOT NULL THEN 'workload' ELSE 'dependency' END",
    t_name: 'coalesce(receiver.service,c.peer)',
    t_env: "coalesce(receiver.environment,'unknown')",
    t_region: "coalesce(receiver.region,'unobserved')",
    t_module: "coalesce(receiver.module,'unknown')",
    route: 'c.route',
    method: 'c.method',
    protocol: 'c.protocol',
  };
  const clientFilter = scope.flowFilter
    ? ' AND ' +
      flowKeys.map((key, i) => `${clientKeys[key]}=${p(scope.flowFilter![i])}`).join(' AND ')
    : '';
  // PostgreSQL may inline rank CTEs and repeat them per CLIENT under selective filters.
  // Materialize SERVER candidates and ancestry ranks once; preserve the 15s statement budget.
  const cte = `WITH RECURSIVE raw AS (${raw}),s AS (SELECT * FROM raw WHERE duplicate_rank=1),servers AS ${postgres ? 'MATERIALIZED ' : ''}(SELECT * FROM s WHERE span_kind='server'),selected AS (SELECT * FROM s WHERE ${selectedConditions.join(' AND ')}),
    receivers AS MATERIALIZED (SELECT trace_id,environment,parent_id,span_id,service,region,module,row_number() OVER(PARTITION BY trace_id,environment,parent_id ORDER BY time,span_id) AS receiver_rank FROM servers WHERE parent_id<>''),
    clients AS MATERIALIZED (SELECT c.* FROM s c ${receiver} LEFT JOIN selected chosen ON chosen.trace_id=c.trace_id AND chosen.environment=c.environment AND chosen.span_id=c.span_id LEFT JOIN selected chosen_receiver ON chosen_receiver.trace_id=receiver.trace_id AND chosen_receiver.environment=receiver.environment AND chosen_receiver.span_id=receiver.span_id WHERE c.span_kind='client' AND c.time>=${p(scope.from)} AND c.time<=${p(scope.to)} AND (chosen.span_id IS NOT NULL OR chosen_receiver.span_id IS NOT NULL)${clientFilter}),
    walk(trace_id,environment,origin_id,parent_id,depth) AS (
      SELECT trace_id,environment,span_id,parent_id,0 FROM clients
      UNION ALL SELECT w.trace_id,w.environment,w.origin_id,p.parent_id,w.depth+1 FROM walk w JOIN s p ON p.trace_id=w.trace_id AND p.environment=w.environment AND p.span_id=w.parent_id WHERE w.depth<15 AND p.parent_id<>''),
    parents AS ${postgres ? 'MATERIALIZED ' : ''}(SELECT trace_id,environment,origin_id,parent_id FROM (SELECT w.*,row_number() OVER(PARTITION BY w.trace_id,w.environment,w.origin_id ORDER BY depth) AS rank FROM walk w JOIN servers p ON p.trace_id=w.trace_id AND p.environment=w.environment AND p.span_id=w.parent_id WHERE p.span_kind='server') ranked WHERE rank=1),
    entries AS ${postgres ? 'MATERIALIZED ' : ''}(SELECT trace_id,environment,origin_id,parent_id FROM (SELECT w.*,row_number() OVER(PARTITION BY w.trace_id,w.environment,w.origin_id ORDER BY p.is_entry DESC,depth DESC) AS rank FROM walk w JOIN servers p ON p.trace_id=w.trace_id AND p.environment=w.environment AND p.span_id=w.parent_id WHERE p.span_kind='server' AND (p.parent_id='' OR p.is_entry=1)) ranked WHERE rank=1),
    outgoing AS (SELECT 'workload' AS s_type,c.service AS s_name,c.environment AS s_env,c.region AS s_region,c.module AS s_module,
      CASE WHEN receiver.span_id IS NOT NULL THEN 'workload' ELSE 'dependency' END AS t_type,coalesce(receiver.service,c.peer) AS t_name,coalesce(receiver.environment,'unknown') AS t_env,coalesce(receiver.region,'unobserved') AS t_region,coalesce(receiver.module,'unknown') AS t_module,
      c.route,c.method,c.protocol,'outbound' AS direction,c.trace_id,c.span_id,c.service,c.environment,c.region,c.module,c.instanceId,c.time,c.duration,CASE WHEN ${bad('c')} THEN 1 ELSE 0 END AS failed,c.status_code,c.error_type,c.resend,
      CASE WHEN receiver.span_id IS NOT NULL THEN 1 ELSE 0 END AS paired,p.span_id AS parent_span,p.duration AS parent_duration,p.route AS parent_route,
      CASE WHEN p.span_id IS NULL THEN NULL WHEN ${bad('p')} THEN 1 ELSE 0 END AS parent_failed,r.span_id AS entry_span,r.duration AS entry_duration,r.route AS entry_route,r.service AS entry_service,CASE WHEN r.span_id IS NULL THEN NULL WHEN ${bad('r')} THEN 1 ELSE 0 END AS entry_failed
      FROM clients c ${receiver} LEFT JOIN parents ap ON ap.trace_id=c.trace_id AND ap.environment=c.environment AND ap.origin_id=c.span_id LEFT JOIN servers p ON p.trace_id=c.trace_id AND p.environment=c.environment AND p.span_id=ap.parent_id LEFT JOIN entries er ON er.trace_id=c.trace_id AND er.environment=c.environment AND er.origin_id=c.span_id LEFT JOIN servers r ON r.trace_id=c.trace_id AND r.environment=c.environment AND r.span_id=er.parent_id),
    incoming AS (SELECT CASE WHEN parent.span_id IS NULL THEN 'caller' ELSE 'workload' END AS s_type,coalesce(parent.service,c.caller) AS s_name,coalesce(parent.environment,'unknown') AS s_env,coalesce(parent.region,'unobserved') AS s_region,coalesce(parent.module,'unknown') AS s_module,
      'workload' AS t_type,c.service AS t_name,c.environment AS t_env,c.region AS t_region,c.module AS t_module,
      c.route,c.method,c.protocol,'inbound' AS direction,c.trace_id,c.span_id,c.service,c.environment,c.region,c.module,c.instanceId,c.time,c.duration,CASE WHEN ${bad('c')} THEN 1 ELSE 0 END AS failed,c.status_code,c.error_type,c.resend,0 AS paired,
      NULL AS parent_span,CAST(NULL AS ${postgres ? 'double precision' : 'REAL'}) AS parent_duration,NULL AS parent_route,CAST(NULL AS INTEGER) AS parent_failed,NULL AS entry_span,CAST(NULL AS ${postgres ? 'double precision' : 'REAL'}) AS entry_duration,NULL AS entry_route,NULL AS entry_service,CAST(NULL AS INTEGER) AS entry_failed
      FROM selected c LEFT JOIN s parent ON parent.trace_id=c.trace_id AND parent.environment=c.environment AND parent.span_id=c.parent_id WHERE c.span_kind='server' AND (parent.span_id IS NULL OR parent.span_kind<>'client')),
    edges AS (SELECT * FROM outgoing UNION ALL SELECT * FROM incoming),filtered AS (SELECT * FROM edges ${scope.flowFilter ? 'WHERE ' + flowKeys.map((k, i) => `${k}=${p(scope.flowFilter![i])}`).join(' AND ') : ''})`;
  const percentile = (pct: number) =>
    `max(CASE WHEN rn=CAST((population*${pct}+99)/100 AS ${postgres ? 'bigint' : 'INTEGER'}) THEN duration ELSE NULL END)`;
  let tail: string;
  if (kind === 'flowEdges') {
    // DISTINCT composite request IDs avoid collapsing repeated attempts into repeated customer failures.
    const requestId = postgres
      ? `CASE WHEN parent_span IS NOT NULL THEN CAST(jsonb_build_array(trace_id,parent_span) AS TEXT) ELSE NULL END`
      : `CASE WHEN parent_span IS NOT NULL THEN json_array(trace_id,parent_span) ELSE NULL END`;
    const entryId = requestId.replaceAll('parent_span', 'entry_span');
    tail = `,ranked AS (SELECT *,row_number() OVER(PARTITION BY ${keyCols} ORDER BY duration) AS rn,count(*) OVER(PARTITION BY ${keyCols}) AS population FROM filtered)
      SELECT ${keyCols},max(direction) AS direction,count(*) AS count,sum(failed) AS errors,avg(duration) AS average_ms,max(duration) AS maximum_ms,${percentile(50)} AS p50_ms,${percentile(95)} AS p95_ms,
      sum(paired) AS paired,sum(CASE WHEN status_code>=400 AND status_code<500 THEN 1 ELSE 0 END) AS client_errors,sum(CASE WHEN status_code=429 THEN 1 ELSE 0 END) AS throttled,sum(CASE WHEN lower(coalesce(error_type,'')) LIKE '%timeout%' THEN 1 ELSE 0 END) AS timeouts,sum(CASE WHEN resend>0 THEN 1 ELSE 0 END) AS retries,
      count(DISTINCT ${requestId}) AS parent_requests,count(DISTINCT CASE WHEN failed=1 AND parent_failed=1 THEN ${requestId} ELSE NULL END) AS impacted_requests,count(DISTINCT CASE WHEN failed=1 AND parent_failed=0 THEN ${requestId} ELSE NULL END) AS recovered_requests,count(DISTINCT ${entryId}) AS entry_requests,count(DISTINCT CASE WHEN failed=1 AND entry_failed=1 THEN ${entryId} ELSE NULL END) AS impacted_entries,count(DISTINCT CASE WHEN failed=1 AND entry_failed=0 THEN ${entryId} ELSE NULL END) AS recovered_entries,min(time) AS first_seen,max(time) AS last_seen FROM ranked GROUP BY ${keyCols} ORDER BY count DESC LIMIT 1001`;
  } else if (kind === 'flowBuckets') {
    const bucket = `CAST(time/${stepMs} AS ${postgres ? 'bigint' : 'INTEGER'})*${stepMs}`;
    tail = `,bucketed AS (SELECT *,${bucket} AS bucket FROM filtered),ranked AS (SELECT *,row_number() OVER(PARTITION BY bucket ORDER BY duration) AS rn,count(*) OVER(PARTITION BY bucket) AS population FROM bucketed) SELECT bucket,count(*) AS count,sum(failed) AS errors,avg(duration) AS average_ms,${percentile(95)} AS p95_ms FROM ranked GROUP BY bucket ORDER BY bucket LIMIT 1001`;
  } else if (kind === 'flowHistogram') {
    const bucket = `CAST(time/${stepMs} AS ${postgres ? 'bigint' : 'INTEGER'})*${stepMs}`;
    const bin = `CASE ${durationBounds.map((b, i) => `WHEN duration<=${b} THEN ${i}`).join(' ')} ELSE ${durationBounds.length} END`;
    tail = ` SELECT ${bucket} AS bucket,${bin} AS bin,count(*) AS count FROM filtered GROUP BY ${bucket},${bin} ORDER BY bucket,bin LIMIT 1001`;
  } else {
    tail = ` SELECT trace_id,span_id,service,environment,region,module,instanceId AS instance_id,time,duration,failed,status_code,error_type,resend,parent_duration,parent_failed,parent_route,entry_duration,entry_failed,entry_route,entry_service FROM filtered ORDER BY failed DESC,duration DESC,time DESC LIMIT 12`;
  }
  return { sql: cte + tail, values, stepMs };
}
