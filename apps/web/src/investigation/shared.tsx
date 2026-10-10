import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { request, queryString } from '../api';
import type { PageProps } from '../Pages';
export function useData<T>(path: string, p: PageProps) {
  return useQuery({
    queryKey: [path, p.params],
    queryFn: ({ signal }) => request<T>(path + '?' + queryString(p.params), { signal }),
    refetchInterval: p.paused ? false : 10000,
  });
}
export function Feedback({ error }: { error: Error | null }) {
  return error ? (
    <div className="notice" role="alert">
      {error.message}
    </div>
  ) : null;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}
