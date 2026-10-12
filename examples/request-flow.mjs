/** Local-only caller → gateway → orders → simulated provider. No external API call. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignalDeskClient } from '../packages/sdk/index.js';
import { SignalDeskTracing } from '../packages/sdk/tracing.node.js';
const endpoint = process.env.SIGNALDESK_URL ?? 'http://127.0.0.1:4319';
const clients = [],
  servers = [];
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
function tracing(service, region, origins = [], trustIncomingContext = false) {
  const client = new SignalDeskClient({
    endpoint,
    token: process.env.SIGNALDESK_TOKEN ?? '',
    resource: {
      service,
      environment: 'example',
      region,
      module: 'api',
      instanceId: service + '-' + randomUUID(),
    },
  });
  clients.push(client);
  return new SignalDeskTracing({ client, propagateOrigins: origins, trustIncomingContext });
}
function instrument(t, route, work, caller) {
  return async (req, res) => {
    try {
      const result = await t.server(
        { method: req.method, route, headers: req.headers, caller, entry: Boolean(caller) },
        work,
      );
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  };
}
try {
  let attempts = 0;
  const provider = await listen(async (_req, res) => {
    const attempt = ++attempts;
    await new Promise((r) => setTimeout(r, attempt % 5 === 0 ? 180 : 25));
    res.writeHead(attempt % 4 === 1 ? 503 : 200);
    res.end('{}');
  });
  const orders = tracing('example-flow-orders', 'us-east-1', [], true);
  const ordersURL = await listen(
    instrument(orders, '/orders', async () => {
      let response;
      for (let resendCount = 0; resendCount < 2; resendCount++) {
        response = await orders.fetch(
          provider + '/charge?private=value',
          { method: 'POST', signal: AbortSignal.timeout(1000) },
          { routeTemplate: '/charge', peerService: 'example-provider', resendCount },
        );
        await response.text();
        if (response.ok) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      orders.log(
        response.ok ? 'info' : 'error',
        response.ok ? 'Order completed' : 'Provider call failed',
        { operation: 'charge' },
      );
      return { status: response.ok ? 200 : 503, body: { ok: response.ok } };
    }),
  );
  const gateway = tracing('example-flow-gateway', 'ap-northeast-2', [ordersURL]);
  const gatewayURL = await listen(
    instrument(
      gateway,
      '/checkout',
      async () => {
        const response = await gateway.fetch(
          ordersURL + '/orders',
          { method: 'POST', signal: AbortSignal.timeout(2000) },
          { routeTemplate: '/orders' },
        );
        await response.text();
        return { status: response.status, body: { ok: response.ok } };
      },
      'example-browser',
    ),
  );
  let successful = 0;
  for (let i = 0; i < 24; i++) {
    const response = await fetch(gatewayURL + '/checkout', { method: 'POST' });
    await response.text();
    successful += response.ok ? 1 : 0;
  }
  for (const client of clients) {
    while (client.queue.length) {
      const receipt = await client.flush();
      if (receipt.retryPending || receipt.rejected)
        throw new Error('Telemetry upload failed; check SignalDesk endpoint and ingest permission');
    }
  }
  console.log(
    JSON.stringify(
      {
        requests: 24,
        successful,
        providerAttempts: attempts,
        workspace: 'live',
        environment: 'example',
        view: endpoint + '/?page=overview&workspace=live&environment=example&range=15m',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
}
