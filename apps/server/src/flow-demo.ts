import type { Storage } from './storage.ts';
import type { Span, TelemetryEvent } from '../../../packages/contracts/src/index.ts';
/** Explicit fixtures: never contact any provider or overwrite live telemetry. */
export async function seedRequestFlowDemo(store: Storage, now: number) {
  if (await store.setting('request-flow-demo-v1')) return;
  const events: TelemetryEvent[] = [],
    regions = ['ap-northeast-2', 'us-east-1', 'eu-west-1'];
  for (let i = 0; i < 150; i++) {
    const timestamp = now - (149 - i) * 20000,
      region = regions[i % 3],
      paymentRegion = regions[(i + 1) % 3],
      outage = i > 112 && region === 'ap-northeast-2',
      recover = outage && i % 2 === 1;
    const traceId = 'flow-demo-' + i.toString().padStart(4, '0'),
      duration = outage ? (recover ? 1200 : 1700) : 180 + (i % 12) * 10;
    const emit = (
      spanId: string,
      service: string,
      spanKind: Span['spanKind'],
      start: number,
      ms: number,
      parentSpanId: string | undefined,
      attrs: Span['attributes'],
      failed = false,
      peerRegion = region,
    ) =>
      events.push({
        kind: 'span',
        id: traceId + ':' + spanId,
        traceId,
        spanId,
        parentSpanId,
        spanKind,
        timestamp: start,
        service,
        environment: 'production',
        region: peerRegion,
        module:
          service === 'payment-worker'
            ? 'payments'
            : service === 'api-gateway'
              ? 'edge'
              : 'checkout',
        zone: peerRegion + 'a',
        cluster: 'prod-' + peerRegion,
        namespace: 'commerce',
        instanceId: service + '-' + ((i % 2) + 1),
        name:
          String(attrs['http.request.method'] ?? 'POST') +
          ' ' +
          String(attrs['http.route'] ?? attrs['url.template'] ?? 'request'),
        durationMs: ms,
        status: failed ? 'error' : 'ok',
        attributes: { 'span.kind': spanKind ?? 'internal', ...attrs },
      });
    emit(
      'gateway',
      'api-gateway',
      'server',
      timestamp,
      duration + 25,
      undefined,
      {
        'http.route': '/v1/checkout',
        'http.request.method': 'POST',
        'http.response.status_code': outage && !recover ? 502 : 200,
        'signaldesk.caller': i % 5 === 0 ? '파트너 API' : '모바일 앱',
      },
      outage && !recover,
    );
    emit(
      'gateway-client',
      'api-gateway',
      'client',
      timestamp + 5,
      duration + 10,
      'gateway',
      {
        'peer.service': 'checkout-api',
        'server.address': 'checkout.internal',
        'url.template': '/v1/checkout',
        'http.request.method': 'POST',
        'http.response.status_code': outage && !recover ? 502 : 200,
      },
      outage && !recover,
    );
    emit(
      'checkout',
      'checkout-api',
      'server',
      timestamp + 10,
      duration,
      'gateway-client',
      {
        'http.route': '/v1/checkout',
        'http.request.method': 'POST',
        'http.response.status_code': outage && !recover ? 502 : 200,
      },
      outage && !recover,
    );
    emit(
      'payment-client',
      'checkout-api',
      'client',
      timestamp + 25,
      duration - 35,
      'checkout',
      {
        'peer.service': 'payment-worker',
        'server.address': 'payment.internal',
        'url.template': '/authorize',
        'http.request.method': 'POST',
        'http.response.status_code': outage && !recover ? 502 : 200,
      },
      outage && !recover,
    );
    emit(
      'payment',
      'payment-worker',
      'server',
      timestamp + 30,
      duration - 45,
      'payment-client',
      {
        'http.route': '/authorize',
        'http.request.method': 'POST',
        'http.response.status_code': outage && !recover ? 502 : 200,
      },
      outage && !recover,
      paymentRegion,
    );
    emit(
      'bank-client',
      'payment-worker',
      'client',
      timestamp + 45,
      outage ? 750 : 90 + (i % 10) * 7,
      'payment',
      {
        'server.address': 'payments.example.test',
        'url.template': '/v1/authorize',
        'http.request.method': 'POST',
        ...(outage
          ? { 'error.type': i % 2 ? 'timeout' : '503' }
          : { 'http.response.status_code': 200 }),
        'http.request.resend_count': 0,
      },
      outage,
      paymentRegion,
    );
    if (recover)
      emit(
        'bank-retry',
        'payment-worker',
        'client',
        timestamp + 850,
        180,
        'payment',
        {
          'server.address': 'payments.example.test',
          'url.template': '/v1/authorize',
          'http.request.method': 'POST',
          'http.response.status_code': 200,
          'http.request.resend_count': 1,
        },
        false,
        paymentRegion,
      );
    emit('stock-client', 'checkout-api', 'client', timestamp + 32, 60 + (i % 5) * 9, 'checkout', {
      'server.address': 'inventory.example.test',
      'url.template': '/v1/stock/:sku',
      'http.request.method': 'GET',
      'http.response.status_code': 200,
    });
    if (outage)
      events.push({
        kind: 'log',
        id: traceId + ':failure-log',
        timestamp: timestamp + 50,
        service: 'payment-worker',
        environment: 'production',
        region: paymentRegion,
        module: 'payments',
        instanceId: 'payment-worker-' + ((i % 2) + 1),
        level: 'error',
        message: recover
          ? 'Payment provider attempt failed; retry returned success'
          : 'Payment provider attempt failed; customer request returned error',
        traceId,
        attributes: {
          'server.address': 'payments.example.test',
          'error.type': i % 2 ? 'timeout' : '503',
        },
      });
  }
  for (let i = 0; i < events.length; i += 500) await store.append('demo', events.slice(i, i + 500));
  await store.setSetting('request-flow-demo-v1', '1');
}
