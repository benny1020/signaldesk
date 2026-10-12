import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function setup(output = '.env') {
  const path = resolve(output);
  const secret = () => randomBytes(32).toString('hex');
  const tokens = ['admin', 'viewer', 'ingest'].map((role) => ({
    name: role,
    role,
    workspaces: role === 'ingest' ? ['live'] : ['live', 'demo'],
    token: secret(),
  }));
  const contents = [
    '# Private installation credentials. Keep CHANNEL_KEY separately from database backups.',
    'AUTH_MODE=token',
    'HOST=127.0.0.1',
    'PORT=4319',
    'CHANNEL_KEY=' + secret(),
    'ACCESS_TOKENS=' + JSON.stringify(tokens),
    'POSTGRES_PASSWORD=' + secret(),
    'SEED_DEMO=false',
    'COLLECT_LOCAL=false',
    'REQUIRE_RESOURCE_IDENTITY=true',
    '# For a preview only, change SEED_DEMO to true. Application telemetry must be connected separately.',
    '',
  ].join('\n');
  // Exclusive create protects existing tokens, encrypted notification destinations and credentials.
  await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  return path;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    console.error('Usage: npm run setup -- [--output path]');
    process.exitCode = 1;
  } else {
    try {
      const path = await setup(args[1]);
      console.log(`Created private settings: ${path}`);
      console.log(
        'Open this file privately to retrieve operator/producer tokens. No secrets were printed.',
      );
      console.log('Next: npm run build && npm start. Then: npm run doctor');
    } catch (error) {
      console.error(
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'Settings already exist. Nothing was changed. Choose another --output path for a new installation.'
          : 'Could not create private settings. Check the output directory and permissions.',
      );
      process.exitCode = 1;
    }
  }
}
