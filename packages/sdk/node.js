import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { SignalDeskClient } from './index.js';
/** Single-writer, fsync-backed queue. Replayed events retain IDs; no token is stored. */
export class DurableSignalDeskClient extends SignalDeskClient {
  constructor({ queuePath, ...options }) {
    super(options);
    if (!queuePath) throw new Error('queuePath is required');
    this.queuePath = resolve(queuePath);
    this.lockPath = this.queuePath + '.lock';
    this.fingerprint = createHash('sha256')
      .update(this.endpoint + ':' + this.workspace)
      .digest('hex');
    this.inflight = [];
    this.closed = false;
    mkdirSync(dirname(this.queuePath), { recursive: true, mode: 0o700 });
    try {
      this.lock = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try {
        const pid = Number(readFileSync(this.lockPath, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error('Queue lock is incomplete; verify ownership before removing');
        try {
          process.kill(pid, 0);
        } catch (e) {
          if (e.code === 'ESRCH') alive = false;
          else throw e;
        }
      } catch (e) {
        throw e;
      }
      if (alive) throw new Error('Durable queue already has a live writer');
      unlinkSync(this.lockPath);
      this.lock = openSync(this.lockPath, 'wx', 0o600);
    }
    try {
      writeFileSync(this.lock, String(process.pid));
      fsyncSync(this.lock);
      try {
        const saved = JSON.parse(readFileSync(this.queuePath, 'utf8'));
        if (saved.fingerprint !== this.fingerprint || !Array.isArray(saved.events))
          throw new Error('Queue endpoint/workspace mismatch or invalid journal');
        this.queue = saved.events;
        this.dropped = saved.dropped ?? 0;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (this.queue.length > this.maxQueue)
        throw new Error('Existing queue exceeds configured maxQueue');
      this.persist();
    } catch (error) {
      closeSync(this.lock);
      unlinkSync(this.lockPath);
      throw error;
    }
  }
  persist() {
    const temp = this.queuePath + '.tmp';
    const fd = openSync(temp, 'w', 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          fingerprint: this.fingerprint,
          events: [...this.inflight, ...this.queue],
          dropped: this.dropped,
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.queuePath);
    const dir = openSync(dirname(this.queuePath), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  emit(event) {
    if (this.closed) throw new Error('Queue is closed');
    // Capacity includes events awaiting a response, not just the in-memory waiting array.
    if (this.queue.length + this.inflight.length >= this.maxQueue) {
      this.dropped++;
      this.persist();
      return false;
    }
    const attributes =
      event.attributes &&
      Object.fromEntries(
        Object.entries(event.attributes).filter(
          ([k]) =>
            !/authorization|password|secret|api.?key|prompt|completion|token(?!s)|tool.call.(arguments|result)|cookie|baggage|http\.(request|response)\.(header|body)|url\.(full|query|path)|http\.(url|target)/i.test(
              k,
            ),
        ),
      );
    const redact = (text) =>
      text
        .replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
        .replace(
          /((?:password|api[_-]?key|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
          '$1[redacted]',
        );
    const clean = {
      ...event,
      ...(attributes
        ? {
            attributes: Object.fromEntries(
              Object.entries(attributes).map(([k, v]) => [
                k,
                typeof v === 'string' ? redact(v) : v,
              ]),
            ),
          }
        : {}),
      ...(event.kind === 'log' ? { message: redact(event.message) } : {}),
    };
    const accepted = super.emit(clean);
    if (accepted) this.persist();
    return accepted;
  }
  flush() {
    if (this.closed) return Promise.reject(new Error('Queue is closed'));
    if (this.durablePending) return this.durablePending;
    this.durablePending = (async () => {
      this.inflight = this.queue.slice(0, this.batchSize);
      try {
        const result = await super.flush();
        this.inflight = [];
        this.persist();
        return result;
      } catch (error) {
        const ids = new Set(this.queue.map((e) => e.id));
        this.queue.unshift(...this.inflight.filter((e) => !ids.has(e.id)));
        this.inflight = [];
        this.persist();
        throw error;
      } finally {
        this.durablePending = null;
      }
    })();
    return this.durablePending;
  }
  close() {
    if (this.pending || this.durablePending)
      throw new Error('Wait for flush before closing the durable queue');
    if (!this.closed) {
      this.persist();
      closeSync(this.lock);
      unlinkSync(this.lockPath);
      this.closed = true;
    }
  }
}
