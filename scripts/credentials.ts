import { randomBytes } from 'node:crypto';
console.log('AUTH_MODE=token');
console.log('CHANNEL_KEY=' + randomBytes(32).toString('hex'));
console.log(
  'ACCESS_TOKENS=' +
    JSON.stringify(
      ['admin', 'viewer', 'ingest'].map((role) => ({
        name: role,
        role,
        workspaces: ['live', 'demo'],
        token: randomBytes(32).toString('hex'),
      })),
    ),
);

console.log('POSTGRES_PASSWORD=' + randomBytes(24).toString('hex'));
