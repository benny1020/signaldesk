import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP, BlockList } from 'node:net';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const blocked = new BlockList(),
  globalV6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');
globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  return family === 4
    ? !blocked.check(ip, 'ipv4')
    : family === 6 && globalV6.check(ip, 'ipv6') && !blocked.check(ip, 'ipv6');
}
export async function safeRequest(
  raw: string,
  body?: unknown,
  allowedHosts: string[] = [],
): Promise<{ status: number; durationMs: number }> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Use an HTTPS URL without user credentials');
  if (url.port && url.port !== '443') throw new Error('Only HTTPS port 443 is supported');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
  if (
    !addresses.length ||
    (!allowedHosts.includes(hostname) && addresses.some((a) => !publicAddress(a.address)))
  )
    throw new Error('Private or reserved destinations are blocked');
  const chosen = addresses[0],
    start = performance.now(),
    payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions & { autoSelectFamily: boolean } = {
      method: payload ? 'POST' : 'GET',
      autoSelectFamily: false,
      timeout: 5000,
      lookup: (_host, _options, cb) => cb(null, chosen.address, chosen.family),
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : { 'user-agent': 'SignalDesk/0.1' },
    };
    const req = https.request(url, options, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) res.destroy(new Error('Response exceeded 64 KiB'));
      });
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, durationMs: performance.now() - start }),
      );
    });
    req.on('timeout', () => req.destroy(new Error('Destination timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
export function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([
    iv,
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export function decrypt(value: string, key: Buffer) {
  const b = Buffer.from(value, 'base64'),
    decipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString('utf8');
}
