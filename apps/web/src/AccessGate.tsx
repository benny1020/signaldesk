import { useState, type FormEvent } from 'react';
import { Activity, KeyRound, LoaderCircle, RefreshCw } from 'lucide-react';
import { token } from './api';

export function AccessGate({
  error,
  busy,
  connect,
  retry,
}: {
  error?: (Error & { status?: number }) | null;
  busy: boolean;
  connect: (token: string) => void;
  retry: () => void;
}) {
  const [value, setValue] = useState('');
  const authentication = error?.status === 401 || error?.status === 403;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    connect(value.trim());
    setValue('');
  }
  return (
    <main className="access-gate">
      <section className="access-story">
        <div className="access-brand">
          <Activity size={28} /> SignalDesk
        </div>
        <h1>
          각 리전의 운영을
          <br />
          하나의 조사 흐름으로.
        </h1>
        <p>독립 배포의 상태를 비교하고, 내부 서비스에서 외부 API까지 요청의 근거를 확인하세요.</p>
        <div className="access-regions">유럽 · 북미 · 일본 · 싱가포르 · 서울</div>
      </section>
      <section className="access-panel">
        <KeyRound size={26} />
        <h2>
          {authentication
            ? '워크스페이스에 연결'
            : error
              ? '플랫폼 연결 확인'
              : '연결을 확인하고 있습니다'}
        </h2>
        <p>
          운영자가 발급한 조회 또는 관리자 토큰을 사용하세요. 토큰은 이 탭의 세션에만 저장됩니다.
        </p>
        {error && (!authentication || token()) && (
          <div className="notice" role="alert">
            {error.message}
          </div>
        )}
        {authentication ? (
          <form className="form" onSubmit={submit}>
            <label>
              접근 토큰
              <input
                autoFocus
                required
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={busy}
              />
            </label>
            <button className="button" disabled={busy || !value.trim()}>
              {busy ? '확인 중…' : '연결'}
            </button>
          </form>
        ) : error ? (
          <button className="button" disabled={busy} onClick={retry}>
            <RefreshCw size={16} /> 다시 연결
          </button>
        ) : (
          <div className="access-pending" role="status">
            <LoaderCircle size={20} /> 안전하게 워크스페이스를 확인하고 있습니다.
          </div>
        )}
      </section>
    </main>
  );
}
