export const token = () =>
  typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem('signaldesk-token') ?? '');
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!/^\/(?!\/)/.test(path) || /[\\\u0000-\u0020]/.test(path))
    throw new Error('API 요청은 현재 플랫폼 안에서만 보낼 수 있습니다.');
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(token() ? { authorization: 'Bearer ' + token() } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw Object.assign(
      new Error('서버에 연결할 수 없습니다. 네트워크와 플랫폼 상태를 확인하세요.'),
      {
        status: 0,
      },
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Object.assign(
      new Error('서버 응답을 읽을 수 없습니다. 게이트웨이와 플랫폼 상태를 확인하세요.'),
      {
        status: response.ok ? 502 : response.status,
      },
    );
  }
  if (!response.ok) {
    data = data && typeof data === 'object' ? data : {};
    const detail = Array.isArray(data.details)
      ? data.details
          .slice(0, 2)
          .filter(
            (d: { path?: unknown; message?: unknown }) =>
              Array.isArray(d?.path) && typeof d.message === 'string',
          )
          .map((d: { path: string[]; message: string }) => d.path.join('.') + ': ' + d.message)
          .join(' / ')
      : '';
    const message =
      response.status === 401
        ? '접근 토큰이 올바르지 않거나 만료되었습니다. 운영자에게 발급받은 토큰으로 다시 연결하세요.'
        : data.error === 'Ingest tokens cannot open the operator UI'
          ? '수집용 토큰으로는 화면에 연결할 수 없습니다. 조회 또는 관리자 토큰을 사용하세요.'
          : response.status === 429
            ? '요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도하세요.'
            : (data.error ?? '요청을 완료하지 못했습니다.');
    throw Object.assign(new Error(message + (detail ? ' · ' + detail : '')), {
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
