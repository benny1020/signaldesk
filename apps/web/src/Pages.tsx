import { RuleEditor } from './Investigation';
import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowUpRight,
  Search,
  Download,
  Plus,
  Bell,
  Check,
  ExternalLink,
  Pause,
  Play,
  Activity,
} from 'lucide-react';
import type {
  Dashboard,
  ResourceSummary,
  Log,
  Span,
  Alert,
  Incident,
  Rule,
  Page,
  Workspace,
  Series,
} from '../../../packages/contracts/src/index';
import {
  Chart,
  ChartBoundary,
  Panel,
  Dialog,
  Empty,
  Badge,
  number,
  time,
  ServiceTable,
  Hosts,
  Topology,
  Kpis,
} from './components';
import { request, queryString } from './api';
type Params = Record<string, string | number | undefined>;
export type Selection =
  | { type: 'service'; name: string }
  | { type: 'log'; log: Log }
  | { type: 'trace'; id: string }
  | { type: 'incident'; incident: Incident }
  | ({
      type: 'briefing';
      service?: string;
      environment?: string;
    } & import('../../../packages/contracts/src/index').ResourceSelector);
export type PageProps = {
  data: Dashboard;
  params: Params;
  select: (s: Selection) => void;
  navigate: (page: string, service?: string) => void;
  focusResource: (r: ResourceSummary, page?: string) => void;
  mutate: (path: string, body: unknown, method?: string) => Promise<unknown>;
  openForm: (kind: 'rule' | 'incident' | 'channel' | 'probe', alert?: Alert) => void;
  paused: boolean;
  notify: (message: string) => void;
  updateScope: (patch: Record<string, string | undefined>, replace?: boolean) => void;
  onRange: (from: number, to: number) => void;
};
export function Overview(p: PageProps) {
  const { data: d } = p,
    active = d.incidents.filter((i) => i.status !== 'resolved');
  return (
    <>
      {active.length > 0 && (
        <div className="incident-strip">
          <span className="incident-indicator" />
          <div>
            <strong>{active[0].title}</strong>
            <span>
              {active[0].service} · {statusTextShort(active[0].status)} ·{' '}
              {active[0].owner || '담당 미지정'}
            </span>
          </div>
          <button onClick={() => p.select({ type: 'incident', incident: active[0] })}>
            장애 확인 <ArrowUpRight size={15} />
          </button>
        </div>
      )}
      <Kpis data={d} />
      <div className="overview-grid">
        <Panel
          title="트래픽과 응답"
          meta="동일한 시간 범위의 요청·지연 추이"
          action={
            <button className="text-button" onClick={() => p.navigate('analytics')}>
              분석 열기 <ArrowUpRight size={13} />
            </button>
          }
        >
          <ChartBoundary>
            <Chart
              onRange={p.onRange}
              title="요청량"
              series={[d.series.request_rate]}
              height={166}
            />
            <Chart
              onRange={p.onRange}
              title="응답 지연"
              series={[d.series.latency_p95_ms]}
              height={166}
            />
          </ChartBoundary>
        </Panel>
        <Panel title="운영 상태" meta="서비스별 최근 수집값">
          <div className="health-summary">
            <div
              className="health-ring"
              style={
                {
                  '--healthy':
                    (d.services.length
                      ? d.services.filter((s) => s.status === 'healthy').length / d.services.length
                      : 0) *
                      100 +
                    '%',
                } as React.CSSProperties
              }
            >
              <strong>
                {d.services.filter((s) => s.status === 'healthy').length}
                <small>/ {d.services.length}</small>
              </strong>
            </div>
            <div>
              <strong>정상 서비스</strong>
              <p>
                <span className="dot warning" />
                {d.services.filter((s) => s.status === 'degraded').length}개 서비스 주의
              </p>
              <p>
                <span className="dot muted-dot" />
                {d.services.filter((s) => s.status === 'unknown').length}개 데이터 지연
              </p>
            </div>
          </div>
          <div className="service-status-list">
            {d.services.slice(0, 6).map((s) => (
              <button
                key={s.name + s.environment}
                onClick={() => p.select({ type: 'service', name: s.name })}
              >
                <span>
                  <span className={'dot ' + s.status} />
                  {s.name}
                </span>
                <span>
                  {number(s.latency, 0)} ms
                  <ArrowUpRight size={13} />
                </span>
              </button>
            ))}
          </div>
          {!d.services.length && <Empty>수집된 서비스가 없습니다.</Empty>}
          <button className="panel-footer-link" onClick={() => p.navigate('services')}>
            서비스 전체 보기 <ArrowUpRight size={14} />
          </button>
        </Panel>
        <Panel title="오류율" meta="요청량이 있는 서비스의 가중 평균">
          <ChartBoundary>
            <Chart
              onRange={p.onRange}
              title="오류 비율"
              series={[d.series.error_pct]}
              height={156}
            />
          </ChartBoundary>
        </Panel>
        <Panel
          title="인프라"
          meta="호스트별 최신 리소스 사용량"
          action={
            <button className="text-button" onClick={() => p.navigate('hosts')}>
              전체 보기
            </button>
          }
        >
          <Hosts hosts={d.hosts.slice(0, 3)} now={d.window.to} />
        </Panel>
        <Panel
          title="최근 이벤트"
          meta="로그에서 오류 근거까지"
          action={
            <button className="text-button" onClick={() => p.navigate('logs')}>
              로그 탐색
            </button>
          }
        >
          <div className="event-list">
            {d.logs.slice(0, 5).map((l) => (
              <button key={l.id} onClick={() => p.select({ type: 'log', log: l })}>
                <span className={'event-level ' + l.level}>{l.level}</span>
                <div>
                  <strong>{l.message}</strong>
                  <small>{l.service}</small>
                </div>
                <time>{time(l.timestamp)}</time>
              </button>
            ))}
            {!d.logs.length && <Empty>현재 시간 범위에 로그가 없습니다.</Empty>}
          </div>
        </Panel>
        <Panel
          title="알림 인박스"
          meta="전달 여부와 별개로 확인이 필요합니다"
          action={
            <button className="text-button" onClick={() => p.navigate('alerts')}>
              전체 보기
            </button>
          }
        >
          <div className="alert-mini">
            {d.alerts
              .filter((a) => a.status === 'firing')
              .slice(0, 4)
              .map((a) => (
                <div key={a.id}>
                  <Bell size={17} />
                  <div>
                    <strong>{a.title}</strong>
                    <small>
                      {a.service || '전체 서비스'} ·{' '}
                      {a.reason === 'no_data' ? '데이터 없음' : '임계치 초과'}
                    </small>
                  </div>
                  <Badge value={a.severity} />
                </div>
              ))}
            {!d.alerts.some((a) => a.status === 'firing') && (
              <Empty>현재 활성 알림이 없습니다.</Empty>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}
function statusTextShort(value: string) {
  return (
    (
      {
        investigating: '조사 중',
        identified: '원인 확인',
        monitoring: '복구 관찰',
        resolved: '해결됨',
      } as Record<string, string>
    )[value] ?? value
  );
}
export function Services(p: PageProps) {
  return (
    <>
      <Kpis data={p.data} />
      <Panel title="서비스 및 API" meta="RED 지표 · 요청량, 오류율, 응답 지연">
        <ServiceTable
          services={p.data.services}
          onSelect={(s) => p.select({ type: 'service', name: s.name })}
        />
      </Panel>
      <Panel title="서비스 연결" meta="현재 범위에서 수집한 부모·자식 스팬의 연결">
        <Topology spans={p.data.spans} />
      </Panel>
    </>
  );
}
export function Infrastructure(p: PageProps) {
  const [host, setHost] = useState('');
  const hostSeries = (prefix: string) =>
    Object.entries(p.data.series)
      .filter(([key]) => key.startsWith(prefix + ':') && (!host || key === prefix + ':' + host))
      .slice(0, 4)
      .map(([, s]) => s);
  return (
    <>
      <Panel title="서버 리소스" meta="CPU는 수집 간격의 사용률, 메모리는 OS 기준 사용 비율입니다.">
        <Hosts hosts={p.data.hosts} now={p.data.window.to} />
      </Panel>
      <div className="log-toolbar">
        <label>
          호스트 추이{' '}
          <select aria-label="호스트 추이" value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">모든 호스트 (최대 4개 비교)</option>
            {p.data.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} / {h.region}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="two-column">
        <Panel title="CPU 추이" meta="호스트별 수집 간격의 CPU 사용률">
          <ChartBoundary>
            <Chart
              onRange={p.onRange}
              title="CPU 사용률"
              series={hostSeries('cpu_pct')}
              height={240}
            />
          </ChartBoundary>
        </Panel>
        <Panel title="메모리 추이" meta="호스트별 OS 기준 메모리 사용 비율">
          <ChartBoundary>
            <Chart
              onRange={p.onRange}
              title="메모리 사용률"
              series={hostSeries('memory_pct')}
              height={240}
            />
          </ChartBoundary>
        </Panel>
      </div>
      <div className="notice">
        <Activity size={17} />
        <span>
          Live의 로컬 호스트는 5초마다 수집합니다. 외부 호스트는 JSON 수집 API로 CPU·메모리 측정값을
          전송하세요.
        </span>
        <button className="text-button" onClick={() => p.navigate('connections')}>
          연결 안내
        </button>
      </div>
    </>
  );
}
export function Logs(p: PageProps) {
  const [search, setSearch] = useState(new URLSearchParams(location.search).get('search') ?? ''),
    [debounced, setDebounced] = useState(search),
    [level, setLevel] = useState(new URLSearchParams(location.search).get('level') ?? '');
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      if (search !== (new URLSearchParams(location.search).get('search') ?? ''))
        p.updateScope({ search: search || undefined });
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const sync = () => {
      const u = new URLSearchParams(location.search);
      setSearch(u.get('search') ?? '');
      setDebounced(u.get('search') ?? '');
      setLevel(u.get('level') ?? '');
    };
    addEventListener('popstate', sync);
    return () => removeEventListener('popstate', sync);
  }, []);
  const params = { ...p.params, search: debounced, level, limit: 100 };
  const query = useInfiniteQuery({
    queryKey: ['logs', params],
    queryFn: ({ pageParam }) =>
      request<Page<Log>>('/api/logs?' + queryString({ ...params, cursor: pageParam })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: p.paused ? false : 5000,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [],
    parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 52,
    overscan: 8,
  });
  async function download() {
    try {
      const data = await request<Page<Log>>('/api/export?' + queryString(params)),
        url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        ),
        a = document.createElement('a');
      a.href = url;
      a.download = 'signaldesk-logs.json';
      a.click();
      URL.revokeObjectURL(url);
      p.notify(
        data.truncated
          ? '최대 10,000개 로그를 내보냈습니다. 더 좁은 시간 범위를 선택하세요.'
          : '로그를 내보냈습니다.',
      );
    } catch (e) {
      p.notify((e as Error).message);
    }
  }
  return (
    <Panel
      title="로그 탐색"
      meta="필터를 유지하며 로그와 트레이스를 연결합니다"
      action={
        <button className="button secondary" onClick={download}>
          <Download size={15} /> JSON 내보내기
        </button>
      }
    >
      <div className="log-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="로그 검색"
            placeholder="메시지 검색: timeout, connection…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="로그 수준"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            p.updateScope({ level: e.target.value || undefined });
          }}
        >
          <option value="">모든 수준</option>
          {['error', 'warn', 'info', 'debug'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="muted">{rows.length}개 로드됨</span>
      </div>
      <div className="log-head">
        <span>시간</span>
        <span>수준</span>
        <span>서비스</span>
        <span>메시지</span>
      </div>
      {query.isError ? (
        <Empty>{query.error.message}</Empty>
      ) : query.isPending ? (
        <Empty>로그를 불러오고 있습니다…</Empty>
      ) : !rows.length ? (
        <Empty>검색 결과가 없습니다. 시간 범위와 필터를 확인하세요.</Empty>
      ) : (
        <div className="log-viewport" ref={parent}>
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((item) => {
              const log = rows[item.index];
              return (
                <button
                  key={log.id}
                  className={'log-row ' + (log.level === 'error' ? 'is-error' : '')}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                  onClick={() => p.select({ type: 'log', log })}
                >
                  <time>{time(log.timestamp)}</time>
                  <span className={'event-level ' + log.level}>{log.level}</span>
                  <span className="log-service">{log.service}</span>
                  <code>{log.message}</code>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="pagination">
        <span className="muted">같은 시각의 로그도 중복 없이 다음 페이지로 탐색합니다.</span>
        {query.hasNextPage && (
          <button
            className="button secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? '불러오는 중…' : '다음 100개 불러오기'}
          </button>
        )}
      </div>
    </Panel>
  );
}
export function Traces(p: PageProps) {
  const q = useQuery({
    queryKey: ['traces', p.params],
    queryFn: () =>
      request<import('../../../packages/contracts/src/index').AggregateResult>(
        '/api/analysis/traces?' + queryString(p.params),
      ),
    refetchInterval: p.paused ? false : 5000,
  });
  return (
    <Panel title="트레이스 탐색" meta="부모가 누락된 부분 트레이스도 표시합니다">
      {q.error && <Empty>{q.error.message}</Empty>}
      {q.data?.truncated && (
        <div className="notice">트레이스 그룹 1,000개 상한입니다. 시간과 서비스를 좁히세요.</div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>요청</th>
              <th>서비스</th>
              <th>상태</th>
              <th className="numeric">관측 경과</th>
              <th className="numeric">스팬 수</th>
              <th>관측 시각</th>
              <th>Trace ID</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((r) => (
              <tr key={String(r.trace_id)}>
                <td>
                  <button
                    className="service-link"
                    onClick={() => p.select({ type: 'trace', id: String(r.trace_id) })}
                  >
                    {String(r.name)} <ArrowUpRight size={13} />
                  </button>
                  {Number(r.root_count) === 0 && (
                    <small className="cell-detail">부모 누락 · 부분 트레이스</small>
                  )}
                </td>
                <td>{String(r.service)}</td>
                <td>
                  <Badge value={Number(r.errors) > 0 ? 'error' : 'ok'} />
                </td>
                <td className="numeric">
                  {number(Number(r.last_seen) - Number(r.first_seen), 0)} ms
                </td>
                <td className="numeric">{number(Number(r.count), 0)}</td>
                <td>{time(Number(r.first_seen))}</td>
                <td className="mono">{String(r.trace_id).slice(0, 18)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data && !q.data.rows.length && (
        <Empty>트레이스가 없습니다. 선택 범위와 수집 상태를 확인하세요.</Empty>
      )}
    </Panel>
  );
}
export function Alerts(p: PageProps) {
  const owners = useQuery({
    queryKey: ['alert-owners', p.params.workspace],
    queryFn: () =>
      request<{ services: { name: string; aliases: string[]; owner: { name: string } | null }[] }>(
        '/api/catalog?' + queryString(p.params),
      ),
  });
  const [editingRule, setEditingRule] = useState<
      import('../../../packages/contracts/src/index').Rule | null
    >(null),
    [snoozeAlert, setSnoozeAlert] = useState<Alert | null>(null),
    [snoozeReason, setSnoozeReason] = useState(''),
    [snoozeMinutes, setSnoozeMinutes] = useState('30');
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('alertTab') ?? 'inbox'),
    [showResolved, setShowResolved] = useState(false),
    rows = p.data.alerts.filter((a) => showResolved || a.status === 'firing');
  useEffect(
    () => setTab(new URLSearchParams(location.search).get('alertTab') ?? 'inbox'),
    [p.params],
  );
  return (
    <>
      <div className="subtabs">
        {[
          ['inbox', '알림 인박스'],
          ['rules', '알림 규칙'],
          ['deliveries', '전달 이력'],
        ].map(([key, label]) => (
          <button
            className={tab === key ? 'active' : ''}
            onClick={() => {
              setTab(key);
              p.updateScope({ alertTab: key });
            }}
            key={key}
          >
            {label}
            {key === 'inbox' && (
              <span>{p.data.alerts.filter((a) => a.status === 'firing').length}</span>
            )}
          </button>
        ))}
      </div>
      {tab === 'inbox' ? (
        <Panel
          title="알림 인박스"
          meta="확인과 일시 중지는 알림을 해결 처리하지 않습니다"
          action={
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              해결된 알림 포함
            </label>
          }
        >
          <div className="alert-list">
            {rows.map((a) => (
              <article key={a.id} className="alert-row">
                <div className={'alert-icon ' + a.severity}>
                  <Bell size={20} />
                </div>
                <div className="alert-content">
                  <div>
                    <strong>{a.title}</strong>
                    <Badge value={a.severity} />
                    <Badge value={a.status} />
                  </div>
                  <p>
                    {a.service || '전체 서비스'} ·{' '}
                    {owners.data?.services.find(
                      (s) => s.name === a.service || s.aliases.includes(a.service),
                    )?.owner?.name ?? '담당 팀 미지정'}{' '}
                    · {a.environment} · {a.region ?? '전체 리전'} · {a.instanceId ?? '그룹'} ·{' '}
                    {a.reason === 'no_data'
                      ? '최근 2분간 데이터 없음'
                      : '측정값 ' + number(a.value, 2)}{' '}
                    · {time(a.createdAt)}
                  </p>
                  <small>
                    {a.acknowledged
                      ? '확인: ' + (a.acknowledgedBy ?? '담당자')
                      : '담당자 확인 대기'}
                    {a.snoozedBy && a.snoozedUntil > Date.now()
                      ? ' · 중단: ' + a.snoozedBy + ' / ' + (a.snoozeReason || '사유 미기록')
                      : ''}
                    {a.snoozedUntil > Date.now()
                      ? ' · ' + time(a.snoozedUntil) + '까지 알림 중지'
                      : ''}
                  </small>
                </div>
                <div className="row-actions">
                  <button
                    className="button secondary"
                    onClick={() =>
                      p.updateScope({
                        page: 'logs',
                        service: a.service,
                        environment: a.environment,
                        ...Object.fromEntries(
                          ['module', 'region', 'zone', 'cluster', 'namespace', 'instanceId'].map(
                            (k) => [k, a[k as keyof Alert] as string | undefined],
                          ),
                        ),
                        from: String(
                          Math.max(
                            (a.resolvedAt ?? p.data.window.to) - 7 * 86400000,
                            a.createdAt - 300000,
                          ),
                        ),
                        to: String(a.resolvedAt ?? p.data.window.to),
                        search: undefined,
                        level: undefined,
                        detail: undefined,
                        detailId: undefined,
                      })
                    }
                  >
                    발생 시점 조사
                  </button>
                  <button
                    className="button secondary"
                    disabled={a.acknowledged}
                    onClick={() =>
                      void p.mutate('/api/alerts/' + a.id, { acknowledged: true }, 'PATCH')
                    }
                  >
                    <Check size={14} />
                    {a.acknowledged ? '확인됨' : '확인'}
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      if (a.snoozedUntil > Date.now())
                        void p.mutate(
                          '/api/alerts/' + a.id,
                          { snoozeMinutes: 0, reason: '중단 해제' },
                          'PATCH',
                        );
                      else {
                        setSnoozeAlert(a);
                        setSnoozeReason('');
                      }
                    }}
                  >
                    {a.snoozedUntil > Date.now() ? '중지 해제' : '30분 중지'}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      const linked = p.data.incidents.find(
                        (i) => i.alertId === a.id && i.status !== 'resolved',
                      );
                      if (linked) p.select({ type: 'incident', incident: linked });
                      else p.openForm('incident', a);
                    }}
                  >
                    {p.data.incidents.some((i) => i.alertId === a.id && i.status !== 'resolved')
                      ? '장애 보기'
                      : '장애 등록'}
                  </button>
                </div>
              </article>
            ))}
            {!rows.length && <Empty>현재 조건에 해당하는 알림이 없습니다.</Empty>}
          </div>
        </Panel>
      ) : tab === 'rules' ? (
        <Panel
          title="알림 규칙"
          meta="임계치 · 지속 시간 · 데이터 없음 정책"
          action={
            <button className="button" onClick={() => p.openForm('rule')}>
              <Plus size={15} /> 규칙 만들기
            </button>
          }
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>규칙</th>
                  <th>서비스 / 환경</th>
                  <th>조건</th>
                  <th>지속 시간</th>
                  <th>데이터 없음</th>
                  <th>활성</th>
                </tr>
              </thead>
              <tbody>
                {p.data.rules.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <button className="text-button" onClick={() => setEditingRule(r)}>
                        편집 · v{r.revision ?? 1}
                      </button>
                      <small>{r.pendingSince !== null ? '조건 지속 시간 확인 중' : ''}</small>
                    </td>
                    <td>
                      {r.service || '전체 서비스'}
                      <small>
                        {r.environment} · {r.region ?? '모든 리전'} · {r.module ?? '모든 모듈'} ·{' '}
                        {r.groupBy === 'service'
                          ? '서비스 합산'
                          : r.groupBy === 'region'
                            ? '리전별'
                            : '인스턴스별'}
                      </small>
                    </td>
                    <td className="mono">
                      {r.metric} {r.operator === 'gt' ? '>' : '<'} {r.threshold}
                    </td>
                    <td>{r.durationSec}초</td>
                    <td>{r.noData === 'alert' ? '알림 발생' : '무시'}</td>
                    <td>
                      <button
                        className={'toggle ' + (r.enabled ? 'on' : '')}
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={r.name + ' 활성'}
                        onClick={() =>
                          void p.mutate('/api/rules/' + r.id, { enabled: !r.enabled }, 'PATCH')
                        }
                      >
                        <span />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!p.data.rules.length && (
            <Empty
              action={
                <button className="button" onClick={() => p.openForm('rule')}>
                  규칙 만들기
                </button>
              }
            >
              수집값을 기준으로 알림 규칙을 만드세요.
            </Empty>
          )}
        </Panel>
      ) : (
        <Deliveries {...p} />
      )}
      {editingRule && <RuleEditor {...p} rule={editingRule} onClose={() => setEditingRule(null)} />}
      {snoozeAlert && (
        <Dialog title="알림 전송 일시 중단" onClose={() => setSnoozeAlert(null)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await p.mutate(
                '/api/alerts/' + snoozeAlert.id,
                { snoozeMinutes: Number(snoozeMinutes), reason: snoozeReason },
                'PATCH',
              );
              if (result) setSnoozeAlert(null);
            }}
          >
            <label>
              중단 기간 (분)
              <input
                required
                type="number"
                min="1"
                max="1440"
                value={snoozeMinutes}
                onChange={(e) => setSnoozeMinutes(e.target.value)}
              />
            </label>
            <label>
              중단 사유
              <textarea
                required
                value={snoozeReason}
                onChange={(e) => setSnoozeReason(e.target.value)}
              />
            </label>
            <button className="button">중단 기록</button>
          </form>
        </Dialog>
      )}
    </>
  );
}
export type Connections = {
  channels: { id: string; name: string; enabled: boolean }[];
  probes: {
    id: string;
    name: string;
    service: string;
    url: string;
    enabled: boolean;
    lastRun: number | null;
    lastStatus: number | null;
    lastDurationMs: number | null;
    lastError: string | null;
  }[];
  deliveries: {
    id: string;
    alert_id: string;
    channel_id: string;
    status: string;
    attempts: number;
    error: string | null;
    created_at: number;
    delivered_at: number | null;
  }[];
  health: {
    storedEvents: number;
    capacity: number;
    accepted: number;
    rejected: number;
    workerHeartbeat: number;
    workerError: string | null;
    retentionDays: number;
    backend: string;
    processRole: string;
    resourceCapacity: number;
    workers: {
      id: string;
      region?: string;
      lastSeen: number;
      heartbeat: number;
      error: string | null;
    }[];
  };
  audit: { time: number; actor: string; action: string; target: string }[];
};
export function useConnections(p: PageProps) {
  return useQuery({
    queryKey: ['connections', p.params.workspace],
    queryFn: () =>
      request<Connections>('/api/connections?' + queryString({ workspace: p.params.workspace })),
    refetchInterval: p.paused ? false : 5000,
  });
}
function Deliveries(p: PageProps) {
  const q = useConnections(p);
  return (
    <Panel
      title="전달 이력"
      meta="Webhook 전달 성공은 장애 해결이나 담당자 확인을 뜻하지 않습니다."
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>전달 ID</th>
              <th>상태</th>
              <th>시도</th>
              <th>발생 시각</th>
              <th>결과</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.deliveries.map((d) => (
              <tr key={d.id}>
                <td className="mono">{d.id.slice(0, 12)}</td>
                <td>
                  <Badge value={d.status} />
                </td>
                <td>{d.attempts} / 5</td>
                <td>{time(d.created_at)}</td>
                <td>{d.error ?? (d.delivered_at ? '전달 ' + time(d.delivered_at) : '—')}</td>
                <td>
                  {d.status === 'failed' && (
                    <button
                      className="button secondary"
                      onClick={() => void p.mutate('/api/deliveries/' + d.id + '/retry', {})}
                    >
                      재시도
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.isError ? (
        <Empty>{q.error.message}</Empty>
      ) : (
        !q.data?.deliveries.length && (
          <Empty>전달 이력이 없습니다. Live에서 알림 채널을 연결하세요.</Empty>
        )
      )}
    </Panel>
  );
}
export function Incidents(p: PageProps) {
  return (
    <Panel
      title="장애 관리"
      meta="근거, 담당자, 복구 과정을 하나의 타임라인으로 기록합니다"
      action={
        <button className="button" onClick={() => p.openForm('incident')}>
          <Plus size={15} /> 장애 등록
        </button>
      }
    >
      <div className="incident-list">
        {p.data.incidents.map((i) => (
          <button key={i.id} onClick={() => p.select({ type: 'incident', incident: i })}>
            <div>
              <Badge value={i.status} />
              <span className="muted">{i.id.slice(0, 12)}</span>
            </div>
            <h3>{i.title}</h3>
            <p>
              {i.service} · {i.environment} · {i.region ?? '전체 리전'} · {i.instanceId ?? '그룹'}
            </p>
            <footer>
              <span>{i.owner || '담당자 미지정'}</span>
              <span>
                {time(i.updatedAt)} 업데이트 <ArrowUpRight size={14} />
              </span>
            </footer>
          </button>
        ))}
        {!p.data.incidents.length && (
          <Empty>등록된 장애가 없습니다. 알림에서 장애를 만들거나 직접 등록하세요.</Empty>
        )}
      </div>
    </Panel>
  );
}
export function Analytics(p: PageProps) {
  const roots = p.data.spans.filter((s) => !s.parentSpanId),
    success = roots.length
      ? (100 * roots.filter((s) => s.status === 'ok').length) / roots.length
      : null,
    groups = new Map<string, { count: number; service: string; traceId?: string }>();
  for (const l of p.data.logs.filter((l) => l.level === 'error')) {
    const key = [
      l.service,
      l.environment,
      l.attributes['exception.type'] ?? '',
      l.attributes['error.code'] ?? '',
      l.message,
    ].join(' / ');
    const item = groups.get(key) ?? { count: 0, service: l.service, traceId: l.traceId };
    item.count++;
    groups.set(key, item);
  }
  const step = Math.max(
      60000,
      Math.ceil((p.data.window.to - p.data.window.from) / 48 / 60000) * 60000,
    ),
    times = Array.from(
      {
        length:
          Math.ceil((p.data.window.to - Math.floor(p.data.window.from / step) * step) / step) + 1,
      },
      (_, i) => Math.floor(p.data.window.from / step) * step + i * step,
    ),
    heat: Series[] = [...new Set(p.data.logs.map((l) => l.service))].map((service) => ({
      name: service,
      unit: '오류 로그',
      points: times.map((t) => [
        t,
        p.data.logs.filter(
          (l) =>
            l.service === service &&
            l.level === 'error' &&
            l.timestamp >= t &&
            l.timestamp < t + step,
        ).length,
      ]),
    }));
  return (
    <>
      <div className="kpi-strip">
        <div>
          <span>관측 요청 성공률</span>
          <strong>
            {number(success, 2)}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>루트 스팬 표본</span>
          <strong>
            {roots.length}
            <small>개</small>
          </strong>
        </div>
        <div>
          <span>오류 그룹</span>
          <strong>
            {groups.size}
            <small>개</small>
          </strong>
        </div>
        <div>
          <span>오류 로그 표본</span>
          <strong>
            {p.data.logs.filter((l) => l.level === 'error').length}
            <small>개</small>
          </strong>
        </div>
      </div>
      <div className="notice">
        성공률은 현재 범위의 수집된 루트 스팬 표본 기준입니다. 전체 요청의 SLO 준수율로 해석하지
        마세요.
      </div>
      <Panel title="서비스별 오류 분포" meta="5분 구간의 오류 로그 수 · 최대 48구간">
        <ChartBoundary>
          <Chart onRange={p.onRange} title="오류 히트맵" series={heat} heatmap height={240} />
        </ChartBoundary>
      </Panel>
      <Panel title="그룹화된 오류" meta="메시지의 숫자를 정규화한 간단한 그룹화입니다.">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>오류 패턴</th>
                <th>서비스</th>
                <th className="numeric">발생 표본</th>
                <th>근거</th>
              </tr>
            </thead>
            <tbody>
              {[...groups]
                .sort((a, b) => b[1].count - a[1].count)
                .map(([message, g]) => (
                  <tr key={message}>
                    <td>
                      <code>{message}</code>
                    </td>
                    <td>{g.service}</td>
                    <td className="numeric">{g.count}</td>
                    <td>
                      {g.traceId && (
                        <button
                          className="text-button"
                          onClick={() => p.select({ type: 'trace', id: g.traceId! })}
                        >
                          트레이스 보기
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!groups.size && <Empty>현재 범위에 오류 로그가 없습니다.</Empty>}
      </Panel>
    </>
  );
}
export function AIWorkloads(p: PageProps) {
  const a = p.data.ai,
    spans = p.data.spans.filter((s) => s.ai),
    series: Series[] = [
      {
        name: '입력 토큰',
        unit: 'tokens',
        points: [...spans].reverse().map((s) => [s.timestamp, s.ai!.inputTokens]),
      },
      {
        name: '출력 토큰',
        unit: 'tokens',
        points: [...spans].reverse().map((s) => [s.timestamp, s.ai!.outputTokens]),
      },
    ];
  return (
    <>
      <div className="kpi-strip">
        <div>
          <span>AI 호출 표본</span>
          <strong>
            {a.calls}
            <small>개</small>
          </strong>
        </div>
        <div>
          <span>입력 / 출력 토큰</span>
          <strong>
            {number(a.inputTokens, 0)}
            <small>/ {number(a.outputTokens, 0)}</small>
          </strong>
        </div>
        <div>
          <span>보고된 비용</span>
          <strong>{a.reportedCost === null ? '—' : '$' + number(a.reportedCost, 4)}</strong>
        </div>
        <div>
          <span>AI 응답 p95</span>
          <strong>
            {number(a.p95, 0)}
            <small>ms</small>
          </strong>
        </div>
      </div>
      <div className="notice">
        <span>
          비용 데이터 포함률 {number(a.costCoverage * 100, 0)}%. 제공된 비용·단가 출처만 사용합니다.
          프롬프트와 응답 본문은 수집 시 제거합니다.
        </span>
      </div>
      <div className="two-column">
        <Panel title="토큰 사용" meta="호출별 입력·출력 토큰">
          <ChartBoundary>
            <Chart onRange={p.onRange} title="토큰 추이" series={series} height={230} />
          </ChartBoundary>
        </Panel>
        <Panel title="모델별 사용" meta="현재 범위의 수집 표본">
          <div className="model-list">
            {a.models.map((m) => (
              <div key={m.name}>
                <strong>{m.name}</strong>
                <div>
                  <span>{m.calls}회</span>
                  <span>{m.cost === null ? '비용 미제공' : '$' + number(m.cost, 4)}</span>
                </div>
                <meter
                  min={0}
                  max={Math.max(1, a.calls)}
                  value={m.calls}
                  aria-label={m.name + ' 호출 수'}
                />
              </div>
            ))}
            {!a.models.length && (
              <Empty>AI 스팬에 provider, model, token 사용량을 포함하세요.</Empty>
            )}
          </div>
        </Panel>
      </div>
      <Panel
        title="품질 평가 근거"
        meta="평가는 수집된 점수이며 플랫폼이 자동 판정한 정확도가 아닙니다."
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>평가 항목</th>
                <th>점수</th>
                <th>출처</th>
                <th>평가자</th>
                <th>트레이스</th>
              </tr>
            </thead>
            <tbody>
              {a.evaluations.map((e, i) => (
                <tr key={e.traceId + i}>
                  <td>{e.name}</td>
                  <td>{number(e.score, 2)}</td>
                  <td>{e.source}</td>
                  <td>{e.evaluator}</td>
                  <td>
                    <button
                      className="text-button mono"
                      onClick={() => p.select({ type: 'trace', id: e.traceId })}
                    >
                      {e.traceId}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!a.evaluations.length && (
          <Empty>
            평가 점수가 없습니다. human·rule·model 출처와 평가자 버전을 함께 전송하세요.
          </Empty>
        )}
      </Panel>
      <Panel title="운영 근거 브리핑" meta="장애 분석을 위한 로컬 규칙 기반 요약">
        <p className="panel-copy">
          알림·오류 로그·실패 스팬을 연결하고 조사할 가설을 제시합니다. 외부 AI 모델을 호출하지
          않으며 원인을 확정하지 않습니다.
        </p>
        <button className="button secondary" onClick={() => p.select({ type: 'briefing' })}>
          근거 브리핑 열기
        </button>
      </Panel>
    </>
  );
}
export function ConnectionsPage(p: PageProps) {
  const q = useConnections(p),
    live = p.params.workspace === 'live';
  return (
    <>
      <div className="two-column">
        <Panel title="수집 상태" meta="공유 저장소 · API와 작업자의 상태">
          {q.data && (
            <dl className="detail-list">
              <dt>저장 엔진 / 역할</dt>
              <dd>
                {q.data.health.backend} / {q.data.health.processRole}
              </dd>
              <dt>저장 이벤트</dt>
              <dd>
                {number(q.data.health.storedEvents, 0)} / {number(q.data.health.capacity, 0)}
              </dd>
              <dt>보존 기간</dt>
              <dd>{q.data.health.retentionDays}일</dd>
              <dt>API 수락 / 거절</dt>
              <dd>
                {q.data.health.accepted} / {q.data.health.rejected} (프로세스 시작 이후)
              </dd>
              <dt>작업 실행 시각</dt>
              <dd>
                {q.data.health.workerHeartbeat ? time(q.data.health.workerHeartbeat) : '실행 대기'}
              </dd>
              <dt>작업 오류</dt>
              <dd>{q.data.health.workerError ?? '보고된 오류 없음'}</dd>
            </dl>
          )}
          {q.isError && <Empty>{q.error.message}</Empty>}
        </Panel>
        <Panel title="서비스 연결" meta="JSON 수집 API · OTLP HTTP JSON 트레이스">
          <p className="panel-copy">
            서비스·환경·리전·모듈·인스턴스를 포함해 데이터를 전송하세요. 배포 단위별 오류를 구분하고
            같은 리전 안의 내부 서비스와 외부 API 호출을 같은 요청의 트레이스로 연결합니다.
          </p>
          <pre className="code-block">{`POST /api/ingest\n{ "workspace": "live", "events": [{\n  "kind": "metric", "name": "error_pct",\n  "value": 0.2, "service": "orders-api",\n  "environment": "production",\n  "region": "ap-northeast-2", "module": "api",\n  "instanceId": "orders-pod-1",\n  "timestamp": ${Date.now()}\n}] }`}</pre>
          <small className="muted">
            OTLP JSON: /api/v1/traces?workspace=live · protobuf/gRPC는 지원하지 않습니다.
          </small>
        </Panel>
      </div>
      {live && (
        <Panel title="작업자 인스턴스" meta="30초 이상 하트비트가 없으면 연결 지연으로 표시합니다.">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>인스턴스</th>
                  <th>리전</th>
                  <th>상태</th>
                  <th>최근 실행</th>
                  <th>오류</th>
                </tr>
              </thead>
              <tbody>
                {q.data?.health.workers.map((w) => (
                  <tr key={w.id}>
                    <td className="mono">{w.id}</td>
                    <td>{w.region ?? 'unknown'}</td>
                    <td>
                      <Badge
                        value={
                          Date.now() - w.lastSeen < 30000
                            ? w.error
                              ? 'degraded'
                              : 'healthy'
                            : 'unknown'
                        }
                      />
                    </td>
                    <td>{w.heartbeat ? time(w.heartbeat) : '실행 대기'}</td>
                    <td>{w.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!q.data?.health.workers.length && <Empty>아직 보고된 작업자가 없습니다.</Empty>}
        </Panel>
      )}
      <Panel
        title="알림 채널"
        meta="HTTPS Webhook · 암호화 저장 · 5회까지 재시도"
        action={
          <button className="button" disabled={!live} onClick={() => p.openForm('channel')}>
            <Plus size={15} /> 채널 연결
          </button>
        }
      >
        <div className="connection-list">
          {q.data?.channels.map((c) => (
            <div key={c.id}>
              <Bell size={18} />
              <strong>{c.name}</strong>
              <span>{c.enabled ? '사용 중' : '중지됨'}</span>
              <button
                className="button secondary"
                onClick={() =>
                  void p.mutate('/api/channels/' + c.id, { enabled: !c.enabled }, 'PATCH')
                }
              >
                {c.enabled ? '중지' : '다시 사용'}
              </button>
            </div>
          ))}
        </div>
        {!q.data?.channels.length && (
          <Empty>
            {live
              ? '알림 발생 시 전달할 Webhook을 연결하세요.'
              : '예제 워크스페이스는 외부 알림을 보내지 않습니다. Live로 전환해 연결하세요.'}
          </Empty>
        )}
      </Panel>
      <Panel
        title="API 가용성 검사"
        meta="HTTPS GET · 60초 간격 · 2xx 응답을 정상으로 판단"
        action={
          <button className="button" disabled={!live} onClick={() => p.openForm('probe')}>
            <Plus size={15} /> API 검사 추가
          </button>
        }
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>검사</th>
                <th>서비스</th>
                <th>최근 응답</th>
                <th>검사 소요</th>
                <th>실행 시각</th>
                <th>오류</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.probes.map((v) => (
                <tr key={v.id}>
                  <td>
                    {v.name}
                    <small>{v.url}</small>
                  </td>
                  <td>{v.service}</td>
                  <td>{v.lastStatus ?? '—'}</td>
                  <td>{v.lastDurationMs == null ? '—' : number(v.lastDurationMs, 0) + ' ms'}</td>
                  <td>{v.lastRun ? time(v.lastRun) : '대기'}</td>
                  <td>{v.lastError ?? '—'}</td>
                  <td>
                    <button
                      className="button secondary"
                      onClick={() =>
                        void p.mutate('/api/probes/' + v.id, { enabled: !v.enabled }, 'PATCH')
                      }
                    >
                      {v.enabled ? '중지' : '시작'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!q.data?.probes.length && <Empty>등록된 API 검사가 없습니다.</Empty>}
      </Panel>
      <Panel title="변경 이력" meta="알림·규칙·장애·연결의 최근 100개 변경">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>작업자</th>
                <th>변경</th>
                <th>대상</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.audit.map((a, i) => (
                <tr key={a.time + i}>
                  <td>{time(a.time)}</td>
                  <td>{a.actor}</td>
                  <td>{a.action}</td>
                  <td className="mono">{a.target.slice(0, 20)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!q.data?.audit.length && <Empty>아직 변경 이력이 없습니다.</Empty>}
      </Panel>
    </>
  );
}
