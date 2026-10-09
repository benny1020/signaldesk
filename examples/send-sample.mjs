import { SignalDeskClient } from '../packages/sdk/index.js';
const client = new SignalDeskClient({
  endpoint: process.env.SIGNALDESK_URL,
  token: process.env.SIGNALDESK_TOKEN,
  resource: {
    module: 'api',
    region: process.env.REGION ?? 'example-local',
    instanceId: 'example-orders-1',
    cluster: 'example',
    namespace: 'examples',
  },
  onError: (e) => console.error(e.message),
});
const timestamp = Date.now(),
  traceId = crypto.randomUUID().replaceAll('-', ''),
  service = 'example-orders-api',
  environment = 'development';
for (const [name, value] of [
  ['request_rate', 28],
  ['error_pct', 0.4],
  ['latency_p95_ms', 185],
])
  client.emit({ kind: 'metric', timestamp, service, environment, name, value });
client.emit({
  kind: 'log',
  timestamp,
  service,
  environment,
  level: 'info',
  message: 'Example order request completed',
  traceId,
  attributes: { 'http.route': '/orders' },
});
client.emit({
  kind: 'span',
  timestamp,
  service,
  environment,
  traceId,
  spanId: traceId.slice(0, 16),
  name: 'GET /orders',
  durationMs: 185,
  status: 'ok',
  attributes: { 'http.response.status_code': 200 },
});
console.log(await client.flush());
