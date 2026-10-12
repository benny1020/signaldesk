import type { ResourceSummary } from './index.ts';

/** Illustrative locations, not an assumed provider or a configured live inventory. */
export const exampleRegions = [
  { id: 'eu-west-1', label: '유럽' },
  { id: 'us-east-1', label: '북미' },
  { id: 'ap-northeast-1', label: '일본' },
  { id: 'ap-southeast-1', label: '싱가포르' },
  { id: 'ap-northeast-2', label: '서울' },
] as const;

export function regionLabel(region: string) {
  return exampleRegions.find((r) => r.id === region)?.label ?? region;
}

/** Keep environment and module boundaries while comparing one service across regions. */
export function regionalComparison(resources: ResourceSummary[]) {
  const applications = resources.filter(
    (r) =>
      !r.retired &&
      (r.observedApplication ||
        !r.host ||
        r.requestRate !== null ||
        r.errorPct !== null ||
        r.latency !== null),
  );
  const allRegions = [...new Set(resources.filter((r) => !r.retired).map((r) => r.region))].sort();
  const regions = allRegions.slice(0, 12);
  const services = new Map<string, ResourceSummary[]>();
  for (const r of applications) {
    const key = JSON.stringify([r.service, r.environment, r.module]);
    const instances = services.get(key) ?? [];
    instances.push(r);
    services.set(key, instances);
  }
  return {
    regions,
    totalRegions: allRegions.length,
    totalServices: services.size,
    truncated: allRegions.length > regions.length || services.size > 50,
    rows: [...services]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 50)
      .map(([key, instances]) => ({
        key,
        service: instances[0].service,
        environment: instances[0].environment,
        module: instances[0].module,
        cells: regions.map((region) => {
          const selected = instances.filter((r) => r.region === region);
          const unknown = selected.filter((r) => r.status === 'unknown').length;
          const degraded = selected.filter((r) => r.status === 'degraded').length;
          const completeRate = selected.length > 0 && selected.every((r) => r.requestRate !== null);
          const rate = completeRate ? selected.reduce((sum, r) => sum + r.requestRate!, 0) : null;
          const completeError = selected.length > 0 && selected.every((r) => r.errorPct !== null);
          const error =
            completeError && rate !== null && rate > 0
              ? selected.reduce((sum, r) => sum + r.requestRate! * r.errorPct!, 0) / rate
              : null;
          const latencies = selected.flatMap((r) => (r.latency === null ? [] : [r.latency]));
          return {
            region,
            instances: selected.length,
            unknown,
            degraded,
            status: !selected.length
              ? 'unobserved'
              : degraded
                ? 'degraded'
                : unknown
                  ? 'unknown'
                  : 'healthy',
            rate,
            error,
            latency: latencies.length ? Math.max(...latencies) : null,
          };
        }),
      })),
  };
}
