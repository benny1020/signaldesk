/** Bounded, framework-independent producer. Events keep stable IDs across retries. */
export class SignalDeskClient {
  constructor({
    endpoint = 'http://127.0.0.1:4319',
    token = '',
    workspace = 'live',
    batchSize = 100,
    maxQueue = 1000,
    fetchImpl = fetch,
    onError = () => {},
    resource = {},
  } = {}) {
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 1000 ||
      !Number.isInteger(maxQueue) ||
      maxQueue < batchSize
    )
      throw new Error('batchSize must be 1–1000 and maxQueue must cover a batch');
    this.resource = resource;
    this.endpoint = endpoint.replace(/\/$/, '');
    this.token = token;
    this.workspace = workspace;
    this.batchSize = batchSize;
    this.maxQueue = maxQueue;
    this.fetch = fetchImpl;
    this.onError = onError;
    this.queue = [];
    this.pending = null;
    this.dropped = 0;
  }
  emit(event) {
    if (this.queue.length >= this.maxQueue) {
      this.dropped++;
      return false;
    }
    this.queue.push({
      ...this.resource,
      ...event,
      id: event.id ?? crypto.randomUUID(),
      timestamp: event.timestamp ?? Date.now(),
    });
    return true;
  }
  async flush() {
    if (this.pending) return this.pending;
    if (!this.queue.length) return { accepted: 0 };
    const batch = this.queue.splice(0, this.batchSize),
      body = JSON.stringify({ workspace: this.workspace, events: batch });
    this.pending = (async () => {
      let last;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await this.fetch(this.endpoint + '/api/ingest', {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
            headers: {
              'content-type': 'application/json',
              ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
            },
            body,
          });
          if (res.ok) return await res.json();
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            const error = new Error('Ingest rejected: HTTP ' + res.status);
            this.onError(error);
            return { accepted: 0, rejected: batch.length };
          }
          throw new Error('Ingest unavailable: HTTP ' + res.status);
        } catch (error) {
          last = error;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        }
      }
      const room = Math.max(0, this.maxQueue - this.queue.length);
      this.queue.unshift(...batch.slice(0, room));
      this.dropped += batch.length - room;
      this.onError(last);
      return { accepted: 0, retryPending: Math.min(room, batch.length) };
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
}
