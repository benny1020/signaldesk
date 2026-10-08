import { SignalDeskClient } from '../packages/sdk/index.js';
const client = new SignalDeskClient({
  endpoint: process.env.SIGNALDESK_URL,
  token: process.env.SIGNALDESK_TOKEN,
});
client.emit({
  kind: 'span',
  timestamp: Date.now(),
  service: 'example-ai-service',
  environment: 'development',
  traceId: crypto.randomUUID(),
  spanId: crypto.randomUUID(),
  name: 'chat completion',
  durationMs: 1400,
  status: 'ok',
  attributes: { 'gen_ai.operation.name': 'chat' },
  ai: {
    provider: 'example',
    model: 'example-model',
    inputTokens: 800,
    outputTokens: 200,
    ttftMs: 260,
    evaluation: { name: 'schema-valid', score: 1, source: 'rule', evaluator: 'example-schema-v1' },
  },
});
// No provider prices are guessed. Include costUsd AND costSource only when known.
console.log(await client.flush());
