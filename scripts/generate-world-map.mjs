import { mkdir, writeFile } from 'node:fs/promises';

// Natural Earth public-domain 1:110m land, pinned for reproducible offline SVG geometry.
const revision = 'ca96624a56bd078437bca8184e78163e5039ad19';
const source = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${revision}/geojson/ne_110m_land.geojson`;
const response = await fetch(source);
if (!response.ok) throw new Error(`Natural Earth download failed: ${response.status}`);
const collection = await response.json();
const project = ([longitude, latitude]) => [
  ((longitude + 180) / 360) * 1000,
  ((80 - latitude) / 140) * 400,
];
const rings = collection.features.flatMap(({ geometry }) =>
  geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat(),
);
const path = rings
  .map(
    (ring) =>
      ring
        .map(
          (point, i) =>
            `${i ? 'L' : 'M'}${project(point)
              .map((v) => v.toFixed(2))
              .join(',')}`,
        )
        .join('') + 'Z',
  )
  .join('');
const destination = new URL('../apps/web/src/maps/', import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(
  new URL('world-land.json', destination),
  JSON.stringify({ source, path }, null, 2) + '\n',
);
