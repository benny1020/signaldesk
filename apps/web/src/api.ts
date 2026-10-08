export const token = () => sessionStorage.getItem('signaldesk-token') ?? '';
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token() ? { authorization: 'Bearer ' + token() } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(data.details)
      ? data.details
          .slice(0, 2)
          .map((d: { path: string[]; message: string }) => d.path.join('.') + ': ' + d.message)
          .join(' / ')
      : '';
    throw Object.assign(new Error((data.error ?? '요청 실패') + (detail ? ' · ' + detail : '')), {
      status: response.status,
      details: data.details,
    });
  }
  return data;
}
export function queryString(params: Record<string, string | number | undefined>) {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}
