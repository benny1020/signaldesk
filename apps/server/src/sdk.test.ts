import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalDeskClient } from '../../../packages/sdk/index.js';
test('producer retries identical event IDs, batches and limits queue', async () => {
  const bodies: string[] = [];
  let attempts = 0;
  const client = new SignalDeskClient({
    maxQueue: 2,
    batchSize: 1,
    fetchImpl: async (_url, options) => {
      bodies.push(String(options?.body));
      attempts++;
      return new Response(attempts === 1 ? '{}' : '{"accepted":1}', {
        status: attempts === 1 ? 503 : 200,
      });
    },
  });
  const event = {
    kind: 'metric' as const,
    timestamp: Date.now(),
    service: 'test',
    environment: 'test',
    name: 'error_pct' as const,
    value: 1,
  };
  assert.equal(client.emit(event), true);
  assert.equal(client.emit(event), true);
  assert.equal(client.emit(event), false);
  assert.equal(client.dropped, 1);
  await client.flush();
  assert.equal(bodies[0], bodies[1]);
  assert.equal(client.queue.length, 1);
});
