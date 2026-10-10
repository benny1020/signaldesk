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
test('durable producer survives close/reopen with stable IDs, redaction and single-writer enforcement', async () => {
  const { DurableSignalDeskClient } = await import('../../../packages/sdk/node.js');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'signaldesk-queue-')),
    path = join(folder, 'events.json');
  try {
    const a = new DurableSignalDeskClient({ queuePath: path, maxQueue: 2, batchSize: 1 });
    a.emit({
      kind: 'log',
      timestamp: Date.now(),
      service: 'orders',
      environment: 'production',
      level: 'error',
      message: 'Bearer private-token',
      attributes: { prompt: 'do not store' },
    });
    const id = a.queue[0].id;
    assert.throws(
      () => new DurableSignalDeskClient({ queuePath: path, maxQueue: 2, batchSize: 1 }),
      /live writer/,
    );
    assert.ok(!readFileSync(path, 'utf8').includes('private-token'));
    assert.ok(!readFileSync(path, 'utf8').includes('do not store'));
    a.close();
    let sent: any;
    const b = new DurableSignalDeskClient({
      queuePath: path,
      maxQueue: 2,
      batchSize: 1,
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(String(options?.body));
        return new Response('{"accepted":1}', { status: 200 });
      },
    });
    assert.equal(b.queue[0].id, id);
    await b.flush();
    assert.equal(sent.events[0].id, id);
    assert.equal(b.queue.length, 0);
    b.close();
    const c = new DurableSignalDeskClient({ queuePath: path, maxQueue: 2, batchSize: 1 });
    assert.equal(c.queue.length, 0);
    c.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
