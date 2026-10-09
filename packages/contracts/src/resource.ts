import { z } from 'zod';

export const dimensionKeys = [
  'module',
  'region',
  'zone',
  'cluster',
  'namespace',
  'instanceId',
] as const;
export type DimensionKey = (typeof dimensionKeys)[number];
export const dimensionSchema = Object.fromEntries(
  dimensionKeys.map((key) => [key, z.string().min(1).max(128).optional()]),
) as Record<DimensionKey, z.ZodOptional<z.ZodString>>;
export type ResourceSelector = Partial<Record<DimensionKey, string>>;
export type ResourceIdentity = Record<DimensionKey, string> & {
  service: string;
  environment: string;
};
export const unknownResource = 'unknown';
export function identity(
  resource: ResourceSelector & { service: string; environment: string; host?: string },
): ResourceIdentity {
  return {
    service: resource.service,
    environment: resource.environment,
    ...Object.fromEntries(
      dimensionKeys.map((key) => [
        key,
        resource[key] ?? (key === 'instanceId' ? resource.host : undefined) ?? unknownResource,
      ]),
    ),
  } as ResourceIdentity;
}
export function resourceKey(
  resource: ResourceSelector & { service: string; environment: string; host?: string },
): string {
  const normalized = identity(resource);
  return JSON.stringify([
    normalized.service,
    normalized.environment,
    ...dimensionKeys.map((key) => normalized[key]),
  ]);
}
export function matchesResource(
  resource: ResourceSelector & { service: string; environment: string },
  scope: ResourceSelector & { service?: string; environment?: string },
) {
  const normalized = identity(resource);
  return ['service', 'environment', ...dimensionKeys].every(
    (key) =>
      !scope[key as keyof typeof scope] ||
      normalized[key as keyof ResourceIdentity] === scope[key as keyof typeof scope],
  );
}
