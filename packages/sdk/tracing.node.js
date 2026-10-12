import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
const id = (bytes) => randomBytes(bytes).toString('hex');
export function parseTraceparent(value) {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value ?? '');
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], spanId: match[2], flags: parseInt(match[3], 16) };
}
/** Explicit native adapter. Use official OTel auto-instrumentation in production.
 * Never captures URL paths/queries, bodies, headers, baggage or exception messages.
 * fetch measures until response headers; application retries remain explicit. */
export class SignalDeskTracing {
  constructor({ client, propagateOrigins = [], trustIncomingContext = false, fetchImpl = fetch }) {
    this.client = client;
    this.context = new AsyncLocalStorage();
    this.trustIncomingContext = trustIncomingContext;
    this.fetchImpl = fetchImpl;
    this.origins = new Set(
      propagateOrigins.map((value) => {
        const u = new URL(value);
        if (
          !['http:', 'https:'].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          u.pathname !== '/'
        )
          throw new Error('Propagation allowlist requires exact HTTP(S) origins');
        return u.origin;
      }),
    );
  }
  current() {
    return this.context.getStore() ?? null;
  }
  async server({ method, route, headers = {}, caller, entry = false }, fn) {
    if (!route || route.length > 200 || /[?#]/.test(route))
      throw new Error('A stable route template is required');
    const header = headers instanceof Headers ? headers.get('traceparent') : headers.traceparent;
    const parent = this.trustIncomingContext ? parseTraceparent(header) : null,
      ctx = { traceId: parent?.traceId ?? id(16), spanId: id(8), flags: parent?.flags ?? 1 };
    return this.context.run(ctx, async () => {
      const start = Date.now(),
        clock = performance.now();
      let status = 200,
        failed = false;
      try {
        const response = await fn(ctx);
        status = response?.status ?? 200;
        failed = status >= 500;
        return response;
      } catch (error) {
        failed = true;
        status = 500;
        throw error;
      } finally {
        if (ctx.flags & 1)
          this.client.emit({
            kind: 'span',
            spanKind: 'server',
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            parentSpanId: parent?.spanId,
            timestamp: start,
            name: method + ' ' + route,
            durationMs: performance.now() - clock,
            status: failed ? 'error' : 'ok',
            attributes: {
              'span.kind': 'server',
              'http.request.method': method,
              'http.route': route,
              'http.response.status_code': status,
              ...(caller ? { 'signaldesk.caller': String(caller).slice(0, 100) } : {}),
              ...(entry ? { 'signaldesk.entry': true } : {}),
            },
          });
      }
    });
  }
  async fetch(input, init = {}, { routeTemplate, peerService, resendCount = 0 } = {}) {
    const url = new URL(input),
      parent = this.current(),
      ctx = { traceId: parent?.traceId ?? id(16), spanId: id(8), flags: parent?.flags ?? 1 };
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
      throw new Error('HTTP(S) request without URL credentials required');
    if (init.redirect && init.redirect !== 'manual')
      throw new Error('Follow redirects explicitly so propagation is checked for each origin');
    if (routeTemplate && (/[?#]/.test(routeTemplate) || routeTemplate.length > 200))
      throw new Error('Use a stable route template without query strings');
    if (!Number.isInteger(resendCount) || resendCount < 0)
      throw new Error('resendCount must be a nonnegative integer');
    const headers = new Headers(init.headers);
    for (const name of ['traceparent', 'tracestate', 'baggage']) headers.delete(name);
    if (parent && this.origins.has(url.origin))
      headers.set(
        'traceparent',
        `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags.toString(16).padStart(2, '0')}`,
      );
    const timestamp = Date.now(),
      clock = performance.now(),
      method = init.method ?? 'GET';
    let statusCode,
      errorType,
      failed = false;
    try {
      const response = await this.fetchImpl(url, { ...init, headers, redirect: 'manual' });
      statusCode = response.status;
      failed = statusCode >= 400;
      return response;
    } catch (error) {
      const intentional = error?.name === 'AbortError';
      failed = !intentional;
      if (!intentional) errorType = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
      throw error;
    } finally {
      if (ctx.flags & 1)
        this.client.emit({
          kind: 'span',
          spanKind: 'client',
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: parent?.spanId,
          timestamp,
          name: method + (routeTemplate ? ' ' + routeTemplate : ''),
          durationMs: performance.now() - clock,
          status: failed ? 'error' : 'ok',
          attributes: {
            'span.kind': 'client',
            'server.address': url.hostname,
            'server.port': Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
            'http.request.method': method,
            'http.request.resend_count': resendCount,
            ...(routeTemplate ? { 'url.template': routeTemplate } : {}),
            ...(peerService ? { 'peer.service': peerService } : {}),
            ...(statusCode ? { 'http.response.status_code': statusCode } : {}),
            ...(errorType ? { 'error.type': errorType } : {}),
          },
        });
    }
  }
  log(level, message, attributes = {}) {
    const ctx = this.current();
    return this.client.emit({
      kind: 'log',
      level,
      message,
      ...(ctx ? { traceId: ctx.traceId } : {}),
      attributes,
    });
  }
}
