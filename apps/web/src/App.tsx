import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard,
  Boxes,
  Server,
  ScrollText,
  GitBranch,
  Bell,
  ShieldAlert,
  ChartNoAxesCombined,
  Sparkles,
  Plug,
  Search,
  Pause,
  Play,
  Plus,
  ChevronDown,
  Check,
  Command,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import type { Dashboard, Alert } from '../../../packages/contracts/src/index';
import {
  Overview,
  Services,
  Infrastructure,
  Logs,
  Traces,
  Alerts,
  Incidents,
  Analytics,
  AIWorkloads,
  ConnectionsPage,
  type Selection,
  type PageProps,
} from './Pages';
import { Dialog, Empty } from './components';
import { CreateForm } from './Forms';
import { Detail } from './Detail';
import { request, queryString } from './api';
const navigation = [
  {
    key: 'overview',
    name: '대시보드',
    icon: LayoutDashboard,
    description: '운영 흐름을 한눈에 확인합니다.',
  },
  {
    key: 'services',
    name: '서비스 및 API',
    icon: Boxes,
    description: '요청량, 오류, 응답 지연을 서비스별로 비교합니다.',
  },
  {
    key: 'hosts',
    name: '인프라',
    icon: Server,
    description: '서버의 리소스와 데이터 신선도를 확인합니다.',
  },
  {
    key: 'logs',
    name: '로그',
    icon: ScrollText,
    description: '필요한 로그를 찾고 요청 근거를 연결합니다.',
  },
  {
    key: 'traces',
    name: '트레이스',
    icon: GitBranch,
    description: '요청 흐름에서 지연과 실패를 찾습니다.',
  },
  {
    key: 'alerts',
    name: '알림 관리',
    icon: Bell,
    description: '규칙부터 확인, 전달 이력까지 관리합니다.',
  },
  {
    key: 'incidents',
    name: '장애 관리',
    icon: ShieldAlert,
    description: '담당자와 조사·복구 과정을 기록합니다.',
  },
  {
    key: 'analytics',
    name: '분석',
    icon: ChartNoAxesCombined,
    description: '오류 패턴과 관측 요청의 상태를 분석합니다.',
  },
  {
    key: 'ai',
    name: 'AI 워크로드',
    icon: Sparkles,
    description: '모델 호출의 지연, 토큰, 비용과 평가 근거를 봅니다.',
  },
  {
    key: 'connections',
    name: '연결 및 설정',
    icon: Plug,
    description: '데이터 수집, 알림 채널과 API 검사를 연결합니다.',
  },
];
const pages: Record<string, (p: PageProps) => React.ReactNode> = {
  overview: Overview,
  services: Services,
  hosts: Infrastructure,
  logs: Logs,
  traces: Traces,
  alerts: Alerts,
  incidents: Incidents,
  analytics: Analytics,
  ai: AIWorkloads,
  connections: ConnectionsPage,
};
export default function App() {
  const [url, setUrl] = useState(() => new URLSearchParams(location.search)),
    [paused, setPaused] = useState(false),
    [selection, setSelection] = useState<Selection | null>(null),
    [form, setForm] = useState<{
      kind: 'rule' | 'incident' | 'channel' | 'probe';
      alert?: Alert;
    } | null>(null),
    [toast, setToast] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [search, setSearch] = useState(''),
    [loginToken, setLoginToken] = useState('');
  const client = useQueryClient(),
    workspace = url.get('workspace') === 'live' ? 'live' : 'demo',
    page = pages[url.get('page') ?? ''] ? url.get('page')! : 'overview',
    env = url.get('environment') ?? '',
    service = url.get('service') ?? '',
    range = url.get('range') ?? '60';
  const params = useMemo(
    () => ({
      workspace,
      environment: env || undefined,
      service: service || undefined,
      rangeMinutes: Number(range),
      from: url.has('from') ? Number(url.get('from')) : undefined,
      to: url.has('to') ? Number(url.get('to')) : undefined,
    }),
    [workspace, env, service, range, url.get('from'), url.get('to')],
  );
  const bootstrap = useQuery({
    queryKey: ['bootstrap', workspace],
    queryFn: () =>
      request<{ mode: string; demoNow: number; version: string }>(
        '/api/bootstrap?workspace=' + workspace,
      ),
    retry: false,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard', params],
    queryFn: () => request<Dashboard>('/api/dashboard?' + queryString(params)),
    enabled: bootstrap.isSuccess,
    refetchInterval: paused ? false : 5000,
  });
  const current = navigation.find((n) => n.key === page)!,
    PageComponent = pages[page];
  const update = useCallback((patch: Record<string, string | undefined>, replace = false) => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    history[replace ? 'replaceState' : 'pushState'](null, '', '?' + next.toString());
    setUrl(next);
  }, []);
  const navigate = (next: string, s?: string) => {
    update({ page: next, ...(s !== undefined ? { service: s } : {}) });
    setSelection(null);
  };
  useEffect(() => {
    const handler = () => {
      setUrl(new URLSearchParams(location.search));
      setSelection(null);
    };
    addEventListener('popstate', handler);
    return () => removeEventListener('popstate', handler);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    addEventListener('keydown', handler);
    return () => removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  async function mutate(path: string, body: unknown, method = 'POST') {
    try {
      const result = await request(path + '?workspace=' + workspace, {
        method,
        body: JSON.stringify(body),
      });
      await client.invalidateQueries();
      setToast('변경을 저장했습니다.');
      return result;
    } catch (e) {
      setToast((e as Error).message);
      return null;
    }
  }
  const props: PageProps | undefined = dashboard.data
    ? {
        data: dashboard.data,
        params,
        select: setSelection,
        navigate,
        mutate,
        openForm: (kind, alert) => setForm({ kind, alert }),
        paused,
        notify: setToast,
      }
    : undefined;
  const errors = (bootstrap.error ?? dashboard.error) as (Error & { status?: number }) | null;
  if (errors?.status === 401)
    return (
      <div className="login">
        <div className="login-brand">SignalDesk</div>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem('signaldesk-token', loginToken);
            void client.resetQueries();
          }}
        >
          <h1>워크스페이스에 연결</h1>
          <p>운영자가 발급한 접근 토큰을 입력하세요.</p>
          <label>
            접근 토큰
            <input
              autoFocus
              required
              type="password"
              value={loginToken}
              onChange={(e) => setLoginToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="button">연결</button>
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="?page=overview&workspace=demo"
          onClick={(e) => {
            e.preventDefault();
            navigate('overview');
          }}
        >
          <svg width="29" height="29" viewBox="0 0 29 29" aria-hidden="true">
            <rect width="29" height="29" rx="8" fill="#4788ed" />
            <path
              d="M5 16h4l3-8 4 14 3-8h5"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
          <span>SignalDesk</span>
        </a>
        <div className="workspace-control">
          <span className="workspace-avatar">{workspace === 'demo' ? 'D' : 'L'}</span>
          <div>
            <span>워크스페이스</span>
            <select
              aria-label="워크스페이스"
              value={workspace}
              onChange={(e) => {
                update({
                  workspace: e.target.value,
                  service: undefined,
                  environment: undefined,
                  from: undefined,
                  to: undefined,
                });
                setSelection(null);
              }}
            >
              <option value="demo">Demo / 예제 데이터</option>
              <option value="live">Live / 실제 수집</option>
            </select>
          </div>
        </div>
        <button className="sidebar-search" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>서비스 빠른 이동</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav aria-label="주 메뉴">
          {navigation.map((item, i) => (
            <a
              key={item.key}
              href={
                '?' + new URLSearchParams({ ...Object.fromEntries(url), page: item.key }).toString()
              }
              className={page === item.key ? 'active' : ''}
              aria-current={page === item.key ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.key);
              }}
            >
              <item.icon size={18} />
              <span>{item.name}</span>
              {item.key === 'alerts' &&
                !!dashboard.data?.alerts.filter((a) => a.status === 'firing').length && (
                  <b>{dashboard.data.alerts.filter((a) => a.status === 'firing').length}</b>
                )}
              {i === 8 && <span className="new-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <a href="https://github.com/benny1020/signaldesk" target="_blank" rel="noreferrer">
            프로젝트 문서 <ArrowUpRight size={14} />
          </a>
          <div>
            <span className="operator-avatar">OP</span>
            <span>
              Operations workspace<small>v0.1.0</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="work-area">
        <header className="context-bar">
          <div className="context-left">
            <button
              aria-label="워크스페이스 전환"
              className={'workspace-pill ' + workspace}
              onClick={() => {
                update({
                  workspace: workspace === 'demo' ? 'live' : 'demo',
                  service: undefined,
                  environment: undefined,
                  from: undefined,
                  to: undefined,
                });
                setSelection(null);
              }}
            >
              {workspace === 'demo' ? '예제 데이터' : '실제 수집'}
            </button>
            <select
              aria-label="환경"
              value={env}
              onChange={(e) => update({ environment: e.target.value })}
            >
              <option value="">모든 환경</option>
              {[
                ...new Set([
                  'production',
                  'local',
                  'staging',
                  ...(dashboard.data?.services.map((s) => s.environment) ?? []),
                ]),
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select
              aria-label="서비스 필터"
              value={service}
              onChange={(e) => update({ service: e.target.value })}
            >
              <option value="">모든 서비스</option>
              {[
                ...new Set([
                  ...(service ? [service] : []),
                  ...(dashboard.data?.services.map((s) => s.name) ?? []),
                ]),
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="context-right">
            <select
              aria-label="시간 범위"
              value={range}
              onChange={(e) => update({ range: e.target.value, from: undefined, to: undefined })}
            >
              <option value="30">최근 30분</option>
              <option value="60">최근 1시간</option>
              <option value="360">최근 6시간</option>
              <option value="1440">최근 24시간</option>
            </select>
            <button
              className={'live-button ' + (paused ? 'is-paused' : '')}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}{' '}
              {paused ? '새로고침 재개' : '5초 새로고침'}
            </button>
            <button
              className="icon-button"
              aria-label="지금 새로고침"
              onClick={() => void client.invalidateQueries()}
            >
              <RefreshCw size={15} className={dashboard.isFetching ? 'spin' : ''} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="breadcrumb">
                운영 워크스페이스 <span>/</span> {current.name}
              </div>
              <h1>{current.name}</h1>
              <p>{current.description}</p>
            </div>
            <div className="heading-actions">
              {page === 'overview' && (
                <button
                  className="button secondary"
                  disabled={!props}
                  onClick={() => setSelection({ type: 'briefing' })}
                >
                  <Sparkles size={15} /> 근거 브리핑
                </button>
              )}
              {page === 'alerts' && (
                <button
                  className="button"
                  disabled={!props}
                  onClick={() => setForm({ kind: 'rule' })}
                >
                  <Plus size={15} /> 규칙 만들기
                </button>
              )}
            </div>
          </div>
          {workspace === 'demo' && (
            <div className="demo-note">
              <span>
                <strong>예제 워크스페이스</strong> 화면과 운영 흐름을 살펴볼 수 있는 고정
                데이터입니다. 변경 내용은 로컬에 저장됩니다.
              </span>
              <button
                className="text-button"
                onClick={() =>
                  update({
                    workspace: 'live',
                    service: undefined,
                    environment: undefined,
                    from: undefined,
                    to: undefined,
                  })
                }
              >
                실제 수집 보기 <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {errors ? (
            <div role="alert" className="error-message">
              {errors.message}
              <button className="button secondary" onClick={() => void client.resetQueries()}>
                다시 연결
              </button>
              <button
                className="text-button"
                onClick={() => {
                  sessionStorage.removeItem('signaldesk-token');
                  void client.resetQueries();
                }}
              >
                토큰 초기화
              </button>
            </div>
          ) : !props ? (
            <div className="loading-workspace">
              <span className="loading-bar" />
              <p>워크스페이스를 불러오고 있습니다…</p>
            </div>
          ) : (
            <>
              {props.data.truncated && page !== 'overview' && (
                <div className="notice">
                  조회 상한 내 표본이 표시됩니다. 전체 분석이 필요하면 시간 범위를 좁히세요. 로그는
                  다음 페이지로 더 탐색할 수 있습니다.
                </div>
              )}
              <PageComponent {...props} />
            </>
          )}
          <footer className="workspace-footer">
            <span>
              {workspace === 'demo' ? '고정 예제 데이터' : '현재 수집 데이터'}
              {dashboard.data
                ? ' · ' + new Date(dashboard.data.window.to).toLocaleString('ko-KR')
                : ''}
            </span>
            <span>수집 데이터 없음은 정상 상태를 뜻하지 않습니다.</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {form && props && (
        <CreateForm
          {...form}
          data={props.data}
          params={params}
          onClose={() => setForm(null)}
          onCreated={() => {
            setForm(null);
            setToast('저장했습니다.');
            void client.invalidateQueries();
          }}
        />
      )}
      {selection && props && (
        <Detail
          key={
            selection.type +
            (selection.type === 'trace'
              ? selection.id
              : selection.type === 'service'
                ? selection.name
                : '')
          }
          {...props}
          selection={selection}
          onClose={() => setSelection(null)}
        />
      )}{' '}
      {searchOpen && (
        <Dialog title="서비스 빠른 이동" onClose={() => setSearchOpen(false)}>
          <div className="search-field">
            <Search size={17} />
            <input
              autoFocus
              aria-label="서비스 찾기"
              placeholder="서비스 이름으로 찾기"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="command-results">
            {dashboard.data?.services
              .filter((s) => s.name.includes(search))
              .map((s) => (
                <button
                  key={s.name + s.environment}
                  onClick={() => {
                    setSearchOpen(false);
                    setSelection({ type: 'service', name: s.name });
                  }}
                >
                  <Boxes size={17} />
                  {s.name}
                  <span>{s.environment}</span>
                </button>
              ))}
            {!dashboard.data?.services.length && <Empty>수집된 서비스가 없습니다.</Empty>}
          </div>
        </Dialog>
      )}
    </div>
  );
}
