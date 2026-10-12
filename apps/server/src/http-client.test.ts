import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../../web/src/api.ts';

test('operator HTTP client preserves proxy status without exposing HTML and handles network failures', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response('<h1>Proxy error with private details</h1>', { status: 503 });
    await assert.rejects(
      request('/api/session'),
      (error: Error & { status?: number }) =>
        error.status === 503 && !error.message.includes('private details'),
    );
    globalThis.fetch = async () => {
      throw new TypeError('connection failed');
    };
    await assert.rejects(
      request('/api/session'),
      (error: Error & { status?: number }) =>
        error.status === 0 && error.message.includes('서버에 연결'),
    );
    globalThis.fetch = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    await assert.rejects(request('/api/session'), { name: 'AbortError' });
    for (const body of [null, { details: [null, { message: 'invalid' }], error: 'Denied' }]) {
      globalThis.fetch = async () => Response.json(body, { status: 403 });
      await assert.rejects(
        request('/api/session'),
        (error: Error & { status?: number }) => error.status === 403,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('operator HTTP client refuses external destinations before sending a request', async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return Response.json({});
  };
  try {
    await assert.rejects(request('https://example.org/api/session'));
    await assert.rejects(request('//example.org/api/session'));
    await assert.rejects(request('/\\example.org/api/session'));
    await assert.rejects(request('/\t/example.org/api/session'));
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
