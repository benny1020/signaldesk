import {
  dimensionKeys,
  type QueryScope,
  type AggregateKind,
} from '../../../packages/contracts/src/index.ts';
export function aggregateSQL(
  kind: AggregateKind,
  scope: QueryScope & { route?: string; latencyMs?: number },
  postgres: boolean,
) {
  const values: unknown[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return postgres ? '$' + values.length : '?';
  };
  const field = (path: string) =>
    postgres ? `(data#>>'{${path.split('.').join(',')}}')` : `json_extract(data,'$.${path}')`;
  const attr = (key: string) =>
    postgres ? `(data->'attributes'->>'${key}')` : `json_extract(data,'$.attributes."${key}"')`;
  const num = (x: string) => `CAST(${x} AS ${postgres ? 'double precision' : 'REAL'})`;
  const statusCode = `coalesce(${attr('http.response.status_code')},${attr('http.status_code')})`;
  const httpFailure = postgres
    ? `(CASE WHEN ${statusCode} ~ '^[0-9]{3}$' THEN CAST(${statusCode} AS integer) ELSE NULL END)>=500`
    : `(CASE WHEN ${statusCode} GLOB '[0-9][0-9][0-9]' THEN CAST(${statusCode} AS INTEGER) ELSE NULL END)>=500`;
  const condition = [
    'workspace=' + param(scope.workspace),
    'time>=' + param(scope.from),
    'time<=' + param(scope.to),
  ];
  for (const key of ['service', 'environment', ...dimensionKeys] as const)
    if (scope[key]) condition.push(`${field(key)}=${param(scope[key])}`);
  if (scope.search)
    condition.push(
      postgres
        ? `strpos(lower(${field('message')}),lower(${param(scope.search)}))>0`
        : `instr(lower(${field('message')}),lower(${param(scope.search)}))>0`,
    );
  if (scope.level) condition.push(field('level') + '=' + param(scope.level));
  const stepMs = Math.max(
    60000,
    Math.ceil((scope.to - scope.from) / (kind === 'metricSeries' ? 120 : 48) / 60000) * 60000,
  );
  const bucket = `CAST(time / ${stepMs} AS ${postgres ? 'bigint' : 'INTEGER'}) * ${stepMs}`;
  const route = `coalesce(${attr('http.route')},${field('name')},'unknown')`;
  const isServer = `(coalesce(${attr('span.kind')},'')='server' OR coalesce(${field('parentSpanId')},'')='')`;
  if (scope.route && !['metricSeries', 'logBuckets', 'errorGroups'].includes(kind))
    condition.push(route + '=' + param(scope.route));
  if (kind === 'metricSeries') {
    condition.push(
      "kind='metric'",
      field('name') + " IN ('request_rate','error_pct','latency_p95_ms')",
    );
    const dims = ['service', 'environment', ...dimensionKeys].map(
        (k) => `coalesce(${field(k)},'unknown')`,
      ),
      parts = [bucket, ...dims, field('name')];
    const pivot = `SELECT bucket,${dims.map((_, i) => 'd' + i).join(',')},max(CASE WHEN metric='request_rate' THEN value ELSE NULL END) AS rate,max(CASE WHEN metric='error_pct' THEN value ELSE NULL END) AS error,max(CASE WHEN metric='latency_p95_ms' THEN value ELSE NULL END) AS latency FROM ranked WHERE n=1 GROUP BY bucket,${dims.map((_, i) => 'd' + i).join(',')}`;
    const sums = `sum(rate) AS request_rate,CASE WHEN count(rate)=count(error) AND count(CASE WHEN rate IS NOT NULL AND error IS NOT NULL THEN 1 END)=count(rate) AND sum(rate)>0 THEN sum(rate*error)/sum(rate) ELSE NULL END AS error_pct,max(latency) AS latency_p95_ms`;
    let sql = `WITH ranked AS (SELECT ${bucket} AS bucket,${dims.map((d, i) => d + ' AS d' + i).join(',')},${field('name')} AS metric,${num(field('value'))} AS value,row_number() OVER (PARTITION BY ${parts.join(',')} ORDER BY time DESC,id DESC) AS n FROM telemetry WHERE ${condition.join(' AND ')}),pivot AS (${pivot}) SELECT bucket,1 AS global_group,NULL AS region,${sums} FROM pivot GROUP BY bucket UNION ALL SELECT bucket,0 AS global_group,d3 AS region,${sums} FROM pivot GROUP BY bucket,d3 ORDER BY bucket LIMIT 1001`;
    if (!postgres) {
      let i = 0;
      sql = sql.replace(/\?/g, () => '?' + ++i);
    }
    return { sql, values, stepMs };
  }
  let select: string,
    group = '';
  if (kind === 'logBuckets') {
    condition.push("kind='log'");
    select = `${bucket} AS bucket,service,environment,${field('level')} AS level,count(*) AS count`;
    group = ` GROUP BY ${bucket},service,environment,${field('level')}`;
  } else if (kind === 'errorGroups') {
    condition.push("kind='log'", field('level') + "='error'");
    const code = `coalesce(${attr('exception.type')},'')`,
      ec = `coalesce(${attr('error.code')},'')`,
      msg = field('message');
    select = `service,environment,${code} AS exception,${ec} AS code,${msg} AS message,count(*) AS count,min(time) AS first_seen,max(time) AS last_seen`;
    group = ` GROUP BY service,environment,${code},${ec},${msg}`;
  } else if (kind === 'sli') {
    condition.push("kind='span'", isServer);
    const bad =
      scope.latencyMs !== undefined
        ? `${num(field('durationMs'))}>${param(scope.latencyMs)}`
        : `${field('status')}='error' OR ${httpFailure}`;
    select = `count(*) AS total,coalesce(sum(CASE WHEN ${bad} THEN 1 ELSE 0 END),0) AS bad`;
  } else if (kind === 'traces') {
    condition.push("kind='span'");
    const root = `CASE WHEN coalesce(${field('parentSpanId')},'')='' THEN 1 ELSE 0 END`;
    select = `${field('traceId')} AS trace_id,coalesce(max(CASE WHEN ${root}=1 THEN ${field('name')} ELSE NULL END),min(${field('name')})) AS name,min(service) AS service,min(environment) AS environment,count(*) AS count,sum(${root}) AS root_count,sum(CASE WHEN ${field('status')}='error' THEN 1 ELSE 0 END) AS errors,min(time) AS first_seen,max(time+${num(field('durationMs'))}) AS last_seen`;
    group = ` GROUP BY ${field('traceId')}`;
  } else if (kind === 'apis') {
    condition.push("kind='span'", isServer);
    const method = `coalesce(${attr('http.request.method')},'unknown')`;
    select = `service,environment,${field('region')} AS region,${route} AS route,${method} AS method,count(*) AS count,sum(CASE WHEN ${field('status')}='error' OR ${httpFailure} THEN 1 ELSE 0 END) AS errors,avg(${num(field('durationMs'))}) AS average_ms,max(${num(field('durationMs'))}) AS maximum_ms,min(time) AS first_seen,max(time) AS last_seen`;
    group = ` GROUP BY service,environment,${field('region')},${route},${method}`;
  } else if (kind === 'ai') {
    condition.push("kind='span'", field('ai.model') + ' IS NOT NULL');
    const fields = ['ai.provider', 'ai.model', 'ai.modelVersion', 'ai.promptVersion', 'ai.stage'];
    const expr = fields.map((p) => `coalesce(${field(p)},'unknown')`);
    select =
      expr
        .map(
          (e, i) =>
            e + ' AS ' + ['provider', 'model', 'model_version', 'prompt_version', 'stage'][i],
        )
        .join(',') +
      `,count(*) AS count,sum(CASE WHEN ${field('status')}='error' THEN 1 ELSE 0 END) AS errors,avg(${num(field('durationMs'))}) AS average_ms,avg(${num(field('ai.ttftMs'))}) AS ttft_ms,sum(${num(field('ai.inputTokens'))}) AS input_tokens,sum(${num(field('ai.outputTokens'))}) AS output_tokens,sum(${num(field('ai.costUsd'))}) AS cost_usd,count(${field('ai.costUsd')}) AS cost_count,count(${field('ai.evaluation')}) AS evaluation_count`;
    group = ' GROUP BY ' + expr.join(',');
  } else {
    condition.push(
      "kind='span'",
      `coalesce(${attr('peer.service')},${attr('messaging.destination.name')},${attr('db.system.name')}) IS NOT NULL`,
    );
    const target = `coalesce(${attr('peer.service')},${attr('messaging.destination.name')},${attr('db.system.name')})`,
      type = `CASE WHEN ${attr('messaging.destination.name')} IS NOT NULL THEN 'messaging' WHEN ${attr('db.system.name')} IS NOT NULL THEN 'database' ELSE 'service' END`;
    select = `service,${field('region')} AS region,${target} AS target,${type} AS type,count(*) AS count,min(time) AS first_seen,max(time) AS last_seen,sum(CASE WHEN ${field('status')}='error' THEN 1 ELSE 0 END) AS errors`;
    group = ` GROUP BY service,${field('region')},${target},${type}`;
  }
  // SELECT placeholders precede WHERE placeholders in SQLite. Named indexes retain correct binding order.
  let sql = `SELECT ${select} FROM telemetry WHERE ${condition.join(' AND ')}${group}${kind === 'sli' ? '' : kind === 'traces' ? ' ORDER BY first_seen DESC LIMIT 1001' : ' ORDER BY count DESC LIMIT 1001'}`;
  if (!postgres) {
    let index = 0; // WHERE parameters were created first, SELECT latency threshold last.
    const indices =
      kind === 'sli' && scope.latencyMs !== undefined
        ? [values.length, ...Array.from({ length: values.length - 1 }, (_, i) => i + 1)]
        : Array.from({ length: values.length }, (_, i) => i + 1);
    sql = sql.replace(/\?/g, () => '?' + indices[index++]);
  }
  return { sql, values, stepMs };
}
