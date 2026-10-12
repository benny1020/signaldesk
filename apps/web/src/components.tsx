import { useEffect, useRef, useId, type ReactNode, lazy, Suspense } from 'react';
import { X, ChevronRight, CheckCircle2, TriangleAlert, Clock, Inbox } from 'lucide-react';
import type {
  Dashboard,
  ServiceSummary,
  HostSummary,
  Span,
} from '../../../packages/contracts/src/index';
export const Chart = lazy(() => import('./Chart'));
export const statusText: Record<string, string> = {
  healthy: '정상',
  degraded: '주의',
  unknown: '데이터 지연',
  critical: '심각',
  warning: '주의',
  firing: '발생 중',
  resolved: '해결됨',
  investigating: '조사 중',
  identified: '원인 확인',
  monitoring: '복구 관찰',
  pending: '대기',
  delivered: '전달됨',
  failed: '실패',
  cancelled: '취소',
  ok: '성공',
  error: '실패',
};
export function Badge({ value, label }: { value: string; label?: string }) {
  const Icon = ['healthy', 'resolved', 'delivered', 'ok'].includes(value)
    ? CheckCircle2
    : ['pending', 'monitoring', 'unknown'].includes(value)
      ? Clock
      : TriangleAlert;
  return (
    <span className={`badge badge-${value}`}>
      <Icon size={12} />
      {label ?? statusText[value] ?? value}
    </span>
  );
}
export const number = (v: number | null | undefined, decimals = 1) =>
  v === null || v === undefined
    ? '—'
    : v.toLocaleString('ko-KR', { maximumFractionDigits: decimals });
export const displayTimeZone = () =>
  new URLSearchParams(location.search).get('timezone') === 'UTC' ? 'UTC' : 'Asia/Seoul';
export const time = (t: number) =>
  new Date(t).toLocaleTimeString('ko-KR', {
    timeZone: displayTimeZone(),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
export function Panel({
  title,
  meta,
  action,
  children,
  className = '',
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={'panel ' + className}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {meta && <span className="muted">{meta}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={27} />
      <p>{children}</p>
      {action}
    </div>
  );
}
export function ChartBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="chart-loading">시각화를 불러오고 있습니다…</div>}>
      {children}
    </Suspense>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null),
    callback = useRef(onClose);
  callback.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const close = () => callback.current();
    dialog.addEventListener('close', close);
    return () => {
      dialog.removeEventListener('close', close);
      dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={drawer ? 'drawer' : 'modal'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button aria-label="닫기" className="icon-button" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
export function ServiceTable({
  services,
  onSelect,
  compact = false,
}: {
  services: ServiceSummary[];
  onSelect: (s: ServiceSummary) => void;
  compact?: boolean;
}) {
  return services.length ? (
    <div className="table-scroll">
      <table className="service-table">
        <thead>
          <tr>
            <th>서비스</th>
            <th>상태</th>
            {!compact && <th>환경</th>}
            <th className="numeric">요청 / 초</th>
            <th className="numeric">오류율</th>
            <th className="numeric">최대 p95</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {services.map((s) => (
            <tr key={s.name + s.environment}>
              <td>
                <button className="service-link" onClick={() => onSelect(s)}>
                  <span className="service-mark">{s.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    {s.name}
                    <small>
                      {s.instances}개 인스턴스 · {s.regions.length}개 리전
                      {compact ? ' · ' + s.environment : ''}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <Badge value={s.status} />
              </td>
              {!compact && <td>{s.environment}</td>}
              <td className="numeric">{number(s.requestRate)}</td>
              <td className={'numeric ' + ((s.errorPct ?? 0) > 1 ? 'danger-text' : '')}>
                {number(s.errorPct, 2)}
                {s.errorPct !== null ? '%' : ''}
              </td>
              <td className="numeric">
                {number(s.latency, 0)}
                {s.latency !== null ? ' ms' : ''}
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={s.name + ' 상세 보기'}
                  onClick={() => onSelect(s)}
                >
                  <ChevronRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>서비스 데이터가 없습니다. 연결 메뉴에서 수집 방법을 확인하세요.</Empty>
  );
}
export function Hosts({ hosts, now }: { hosts: HostSummary[]; now: number }) {
  return hosts.length ? (
    <div className="host-list">
      {hosts.map((h) => (
        <div className="host-row" key={h.id}>
          <div>
            <strong>
              {h.name}
              <small>
                {h.region} · {h.cluster}
              </small>
            </strong>
            <small>
              {now - h.lastSeen > 120000 ? '최근 데이터 없음' : '최근 수집 ' + time(h.lastSeen)}
            </small>
          </div>
          <div className="host-measure">
            <span>
              CPU <b>{number(h.cpu)}%</b>
            </span>
            <meter min={0} max={100} value={h.cpu ?? 0} aria-label={h.name + ' CPU'} />
          </div>
          <div className="host-measure">
            <span>
              메모리 <b>{number(h.memory)}%</b>
            </span>
            <meter min={0} max={100} value={h.memory ?? 0} aria-label={h.name + ' 메모리'} />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty>호스트 데이터가 없습니다. Live에서 로컬 수집 상태를 확인하세요.</Empty>
  );
}
export function TraceWaterfall({
  spans,
  onService,
}: {
  spans: Span[];
  onService?: (span: Span) => void;
}) {
  if (!spans.length) return <Empty>이 범위에서 트레이스가 발견되지 않았습니다.</Empty>;
  const ordered = [...spans].sort((a, b) => a.timestamp - b.timestamp),
    start = Math.min(...spans.map((s) => s.timestamp)),
    end = Math.max(...spans.map((s) => s.timestamp + s.durationMs)),
    duration = Math.max(1, end - start);
  const depth = (span: Span): number => {
    let n = 0,
      parent = span.parentSpanId,
      seen = new Set<string>();
    while (parent && n < 8 && !seen.has(parent)) {
      seen.add(parent);
      const p = spans.find((s) => s.spanId === parent);
      if (!p) break;
      n++;
      parent = p.parentSpanId;
    }
    return n;
  };
  return (
    <div className="waterfall">
      <div className="waterfall-axis">
        <span>스팬</span>
        <div>
          <span>0 ms</span>
          <span>{number(duration / 2, 0)} ms</span>
          <span>{number(duration, 0)} ms</span>
        </div>
      </div>
      {ordered.map((s) => (
        <div className="waterfall-row" key={s.spanId}>
          <div className="span-name" style={{ paddingLeft: depth(s) * 14 }}>
            <strong>{s.name}</strong>
            <small>
              {String(s.spanKind ?? s.attributes?.['span.kind'] ?? 'unknown').toUpperCase()}
              {s.attributes?.['http.response.status_code']
                ? ' / HTTP ' + s.attributes['http.response.status_code']
                : ''}
              {s.attributes?.['http.request.resend_count']
                ? ' / 재전송 ' + s.attributes['http.request.resend_count']
                : ''}
              {s.attributes?.['error.type'] ? ' / ' + s.attributes['error.type'] : ''}
            </small>
            <button className="text-button" onClick={() => onService?.(s)}>
              {s.service} / {s.region ?? '미지정'}
            </button>
          </div>
          <div className="waterfall-track">
            <div
              className={
                'waterfall-bar ' +
                (s.status === 'error' ||
                Number(
                  s.attributes?.['http.response.status_code'] ?? s.attributes?.['http.status_code'],
                ) >=
                  (s.spanKind === 'client' || s.attributes?.['span.kind'] === 'client' ? 400 : 500)
                  ? 'failed'
                  : '')
              }
              style={{
                left: (100 * (s.timestamp - start)) / duration + '%',
                width: Math.max(1, (100 * s.durationMs) / duration) + '%',
              }}
              title={`${s.name}: ${s.durationMs} ms`}
            />
            <span>{number(s.durationMs, 0)} ms</span>
          </div>
        </div>
      ))}
    </div>
  );
}
export function Topology({ spans }: { spans: Span[] }) {
  const byId = new Map(spans.map((s) => [s.traceId + ':' + s.spanId, s])),
    edges = new Map<string, number>();
  for (const s of spans) {
    const p = byId.get(s.traceId + ':' + s.parentSpanId);
    if (p && p.service !== s.service) {
      const k = p.service + '|' + s.service;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  const names = [...new Set([...edges.keys()].flatMap((e) => e.split('|')))].slice(0, 8);
  if (!names.length) return <Empty>서비스 간 부모·자식 스팬이 수집되면 연결이 나타납니다.</Empty>;
  const positions = new Map(
    names.map((n, i) => [n, { x: i % 2 ? 490 : 150, y: 45 + Math.floor(i / 2) * 80 }]),
  );
  return (
    <div className="topology">
      <svg
        viewBox={`0 0 640 ${Math.ceil(names.length / 2) * 80 + 20}`}
        role="img"
        aria-label="수집한 트레이스에서 확인한 서비스 연결"
      >
        <defs>
          <marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7" fill="#829bb4" />
          </marker>
        </defs>
        {[...edges].map(([k, count]) => {
          const [a, b] = k.split('|'),
            p = positions.get(a),
            q = positions.get(b);
          if (!p || !q) return null;
          return (
            <g key={k}>
              <path
                d={`M${p.x + 80},${p.y} C${p.x + 150},${p.y} ${q.x - 150},${q.y} ${q.x - 82},${q.y}`}
                fill="none"
                stroke="#9cb2c7"
                strokeWidth={2}
                markerEnd="url(#arrow)"
              />
              <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 8} textAnchor="middle">
                {count} 스팬
              </text>
            </g>
          );
        })}
        {names.map((n) => {
          const p = positions.get(n)!;
          return (
            <g key={n}>
              <rect
                x={p.x - 80}
                y={p.y - 20}
                width={160}
                height={40}
                rx={7}
                fill="#f3f7fc"
                stroke="#d6e2ef"
              />
              <circle cx={p.x - 66} cy={p.y} r={4} fill="#2869d8" />
              <text x={p.x + 3} y={p.y + 4} textAnchor="middle">
                {n}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
export function Kpis({ data }: { data: Dashboard }) {
  const rate = data.series.request_rate.points.at(-1)?.[1],
    errors = data.series.error_pct.points.at(-1)?.[1],
    latency = data.series.latency_p95_ms.points.at(-1)?.[1];
  return (
    <div className="kpi-strip">
      <div>
        <span>요청량</span>
        <strong>
          {number(rate, 0)}
          <small>req/s</small>
        </strong>
      </div>
      <div>
        <span>요청 가중 오류율</span>
        <strong className={(errors ?? 0) > 1 ? 'danger-text' : ''}>
          {number(errors, 2)}
          <small>%</small>
        </strong>
      </div>
      <div>
        <span>최대 인스턴스 p95</span>
        <strong>
          {number(latency, 0)}
          <small>ms</small>
        </strong>
      </div>
      <div>
        <span>관측 서비스</span>
        <strong>
          {data.services.length}
          <small>개</small>
        </strong>
      </div>
      <div>
        <span>활성 알림</span>
        <strong>
          {data.alerts.filter((a) => a.status === 'firing').length}
          <small>개</small>
        </strong>
      </div>
    </div>
  );
}
