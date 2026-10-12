import {
  Catalog,
  ServiceLevels,
  NotificationPolicies,
  OperationalAnalysis,
  AIOperations,
  APIAnalysis,
  PlatformHealth,
} from './Investigation';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Globe,
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
  LogOut,
} from 'lucide-react';
import type {
  Dashboard,
  Alert,
  ResourceSummary,
  Page,
  Log,
} from '../../../packages/contracts/src/index';
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
import { ResourceScope, Deployments } from './Deployments';
import { dimensionKeys } from '../../../packages/contracts/src/index';
import { Dialog, Empty } from './components';
import { CreateForm } from './Forms';
import { Detail } from './Detail';
import { request, queryString } from './api';
import { RequestFlow } from './flow/RequestFlow';
import { AccessGate } from './AccessGate';
import type { Session } from '../../../packages/contracts/src/session';
import './flow/style.css';
const navigation = [
  {
    key: 'platform',
    name: '플랫폼 상태',
    icon: ShieldAlert,
    description: '현재 수집·저장·평가·전달 상태를 확인합니다.',
  },
  {
    key: 'catalog',
    name: '서비스 카탈로그',
    icon: Boxes,
    description: '서비스 담당 팀과 운영 자료를 연결합니다.',
  },
  {
    key: 'slos',
    name: '서비스 수준',
    icon: ShieldAlert,
    description: '공통 SLI와 오류 예산을 평가합니다.',
  },
  {
    key: 'policies',
    name: '전달 정책',
    icon: Bell,
    description: '담당 팀별 라우팅과 유지보수 시간을 관리합니다.',
  },
  {
    key: 'metrics',
    name: '운영 지표',
    icon: ChartNoAxesCombined,
    description: '서비스와 인프라의 운영 지표를 확인합니다.',
  },

  {
    key: 'overview',
    name: '요청 흐름',
    icon: LayoutDashboard,
    description: '호출자에서 우리 API와 외부 의존성까지 조사합니다.',
  },
  {
    key: 'services',
    name: '서비스 및 API',
    icon: Boxes,
    description: '요청량, 오류, 응답 지연을 서비스별로 비교합니다.',
  },
  {
    key: 'deployments',
    name: '배포 및 인스턴스',
    icon: Globe,
    description: '리전·모듈·클러스터별 배포와 인스턴스를 비교합니다.',
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
].sort(
  (a, b) =>
    [
      'overview',
      'services',
      'catalog',
      'deployments',
      'hosts',
      'logs',
      'traces',
      'alerts',
      'incidents',
      'slos',
      'policies',
      'analytics',
      'metrics',
      'ai',
      'platform',
      'connections',
    ].indexOf(a.key) -
    [
      'overview',
      'services',
      'catalog',
      'deployments',
      'hosts',
      'logs',
      'traces',
      'alerts',
      'incidents',
      'slos',
      'policies',
      'analytics',
      'metrics',
      'ai',
      'platform',
      'connections',
    ].indexOf(b.key),
);
function AIWorkspace(p: PageProps) {
  const [details, setDetails] = useState(false);
  return (
    <>
      <AIOperations {...p} />
      <button
        className="button secondary"
        onClick={() => setDetails(!details)}
        aria-expanded={details}
      >
        {details ? '개별 호출 근거 접기' : '개별 호출·토큰·평가 근거 펼치기'}
      </button>
      {details && <AIWorkloads {...p} />}
    </>
  );
}
const pages: Record<string, (p: PageProps) => React.ReactNode> = {
  overview: RequestFlow,
  metrics: Overview,
  deployments: Deployments,
  services: (p) => (
    <>
      <Services {...p} />
      <APIAnalysis {...p} />
    </>
  ),
  hosts: Infrastructure,
  logs: Logs,
  traces: Traces,
  alerts: Alerts,
  incidents: Incidents,
  analytics: OperationalAnalysis,
  catalog: Catalog,
  platform: PlatformHealth,
  slos: ServiceLevels,
  policies: NotificationPolicies,
  relations: RequestFlow,
  ai: AIWorkspace,
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
    [authRevision, setAuthRevision] = useState(0),
    [timeOpen, setTimeOpen] = useState(false),
    [fromInput, setFromInput] = useState(''),
    [toInput, setToInput] = useState(''),
    [savedViews, setSavedViews] = useState<{ name: string; query: string }[]>(() => {
      try {
        return JSON.parse(localStorage.getItem('signaldesk-views') ?? '[]');
      } catch {
        return [];
      }
    });
  const saveView = () => {
    const name = prompt('저장할 조사 화면 이름');
    if (!name?.trim()) return;
    const query = new URLSearchParams(location.search);
    if (!query.has('from') && dashboard.data) {
      query.set('from', String(dashboard.data.window.from));
      query.set('to', String(dashboard.data.window.to));
    }
    const next = [
      ...savedViews.filter((v) => v.name !== name),
      { name: name.trim(), query: query.toString() },
    ].slice(-20);
    localStorage.setItem('signaldesk-views', JSON.stringify(next));
    setSavedViews(next);
  };
  const client = useQueryClient(),
    workspace = url.get('workspace') === 'live' ? 'live' : 'demo',
    page = pages[url.get('page') ?? ''] ? url.get('page')! : 'overview',
    env = url.get('environment') ?? '',
    service = url.get('service') ?? '',
    range = url.get('range') ?? '60';
  const params = useMemo(
    () => ({
      workspace,
      edge: url.get('edge') || undefined,
      flowView: url.get('flowView') || undefined,
      route: url.get('route') || undefined,
      ...Object.fromEntries(dimensionKeys.map((key) => [key, url.get(key) || undefined])),
      environment: env || undefined,
      service: service || undefined,
      rangeMinutes: Number(range),
      from: url.has('from') ? Number(url.get('from')) : undefined,
      to: url.has('to') ? Number(url.get('to')) : undefined,
    }),
    [workspace, env, service, range, url.toString()],
  );
  const session = useQuery({
    queryKey: ['session', authRevision],
    queryFn: ({ signal }) => request<Session>('/api/session', { signal }),
    retry: false,
  });
  const canWrite = session.data?.canWrite === true;
  const workspaceAllowed = session.data?.workspaces.includes(workspace) === true;
  useEffect(() => {
    if (session.data && (!session.data.workspaces.includes(workspace) || !url.has('workspace')))
      update(
        {
          workspace: session.data.defaultWorkspace,
          service: undefined,
          environment: undefined,
          ...Object.fromEntries(dimensionKeys.map((key) => [key, undefined])),
          from: undefined,
          to: undefined,
        },
        true,
      );
  }, [session.data, workspace, url.toString()]);
  const bootstrap = useQuery({
    queryKey: ['bootstrap', workspace],
    queryFn: () =>
      request<{
        mode: string;
        demoNow: number;
        version: string;
        diagnosisDestination?: string | null;
      }>('/api/bootstrap?workspace=' + workspace),
    retry: false,
    enabled: session.isSuccess && workspaceAllowed,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard', params],
    queryFn: ({ signal }) =>
      request<Dashboard>('/api/dashboard?' + queryString(params), { signal }),
    enabled: bootstrap.isSuccess && workspaceAllowed,
    refetchInterval: paused ? false : 5000,
  });
  const inventory = useQuery({
    queryKey: ['inventory', workspace],
    queryFn: () =>
      request<Page<ResourceSummary>>('/api/resources?' + queryString({ workspace, limit: 10000 })),
    enabled: bootstrap.isSuccess && workspaceAllowed,
    refetchInterval: paused ? false : 10000,
  });
  const selectedLog = useQuery({
    queryKey: ['selected-log', url.get('detailId'), params],
    enabled:
      bootstrap.isSuccess &&
      workspaceAllowed &&
      url.get('detail') === 'log' &&
      !!url.get('detailId'),
    queryFn: () =>
      request<Log>(
        '/api/events/log/' +
          encodeURIComponent(url.get('detailId') ?? '') +
          '?' +
          queryString(params),
      ),
    retry: false,
  });
  const current = (navigation.find((n) => n.key === page) ??
      navigation.find((n) => n.key === 'overview'))!,
    PageComponent = pages[page];
  const update = useCallback((patch: Record<string, string | undefined>, replace = false) => {
    const next = new URLSearchParams(location.search);
    if (
      !Object.hasOwn(patch, 'detail') &&
      ['workspace', 'service', 'environment', ...dimensionKeys, 'from', 'to'].some((key) =>
        Object.hasOwn(patch, key),
      )
    ) {
      next.delete('detail');
      next.delete('detailId');
      setSelection(null);
      if (!Object.hasOwn(patch, 'route')) next.delete('route');
      if (!Object.hasOwn(patch, 'edge')) next.delete('edge');
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    history[replace ? 'replaceState' : 'pushState'](null, '', '?' + next.toString());
    setUrl(next);
  }, []);
  const select = (value: Selection | null) => {
    setSelection(value);
    update({
      ...(value && !url.get('from') && dashboard.data
        ? { from: String(dashboard.data.window.from), to: String(dashboard.data.window.to) }
        : {}),
      detail: value?.type,
      detailId:
        value?.type === 'trace'
          ? value.id
          : value?.type === 'service'
            ? value.name
            : value?.type === 'log'
              ? value.log.id
              : value?.type === 'incident'
                ? value.incident.id
                : undefined,
    });
  };
  useEffect(() => {
    document
      .querySelector('.sidebar nav [aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [page, bootstrap.isSuccess]);
  useEffect(() => {
    const type = url.get('detail'),
      id = url.get('detailId');
    if (type === 'trace' && id) setSelection({ type: 'trace', id });
    else if (type === 'service' && id) setSelection({ type: 'service', name: id });
    else if (type === 'briefing') setSelection({ type: 'briefing' });
    else if (type === 'log' && id) {
      const log = selectedLog.data ?? dashboard.data?.logs.find((l) => l.id === id);
      if (log) setSelection({ type: 'log', log });
    } else if (type === 'incident' && id) {
      const incident = dashboard.data?.incidents.find((i) => i.id === id);
      if (incident) setSelection({ type: 'incident', incident });
    } else setSelection(null);
  }, [url.toString(), dashboard.data, selectedLog.data]);
  const navigate = (next: string, s?: string) => {
    update({
      page: next,
      detail: undefined,
      detailId: undefined,
      search: undefined,
      level: undefined,
      route: undefined,
      edge: undefined,
      ...(s !== undefined ? { service: s } : {}),
    });
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
    if (!canWrite) {
      setToast('변경하려면 관리자 토큰으로 연결하세요.');
      return null;
    }
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
        select,
        navigate,
        focusResource: (r, next = 'logs') => {
          update({
            page: next,
            detail: undefined,
            detailId: undefined,
            search: undefined,
            level: undefined,
            route: undefined,
            service: r.service,
            environment: r.environment,
            ...Object.fromEntries(dimensionKeys.map((key) => [key, r[key]])),
          });
          setSelection(null);
        },
        mutate,
        openForm: (kind, alert) =>
          canWrite ? setForm({ kind, alert }) : setToast('변경하려면 관리자 토큰으로 연결하세요.'),
        canWrite,
        paused,
        updateScope: update,
        onRange: (from, to) => update({ from: String(from), to: String(to) }),
        notify: setToast,
      }
    : undefined;
  const errors = (bootstrap.error ?? dashboard.error ?? selectedLog.error) as
    (Error & { status?: number }) | null;
  async function changeToken(value: string) {
    await client.cancelQueries();
    client.clear();
    if (value) sessionStorage.setItem('signaldesk-token', value);
    else sessionStorage.removeItem('signaldesk-token');
    setSelection(null);
    setForm(null);
    setSearchOpen(false);
    setToast('');
    setAuthRevision((revision) => revision + 1);
  }
  if (session.isPending || session.isError || errors?.status === 401)
    return (
      <AccessGate
        error={session.error ?? (errors?.status === 401 ? errors : null)}
        busy={session.isFetching}
        connect={(value) => void changeToken(value)}
        retry={() => void session.refetch()}
      />
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href={'?page=overview&workspace=' + workspace}
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
                  ...Object.fromEntries(dimensionKeys.map((key) => [key, undefined])),
                  from: undefined,
                  to: undefined,
                });
                setSelection(null);
              }}
            >
              {session.data?.workspaces.includes('demo') && (
                <option value="demo">Demo / 예제 데이터</option>
              )}
              {session.data?.workspaces.includes('live') && (
                <option value="live">Live / 실제 수집</option>
              )}
            </select>
          </div>
        </div>
        <button className="sidebar-search" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>서비스 빠른 이동</span>
          <kbd>⌘ K</kbd>
        </button>
        <label className="sidebar-timezone">
          표시 시간대{' '}
          <select
            aria-label="표시 시간대"
            value={url.get('timezone') === 'UTC' ? 'UTC' : 'Asia/Seoul'}
            onChange={(e) => update({ timezone: e.target.value })}
          >
            <option value="Asia/Seoul">한국 · UTC+09</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
        <nav aria-label="주 메뉴">
          {navigation.map((item) => (
            <a
              key={item.key}
              aria-label={item.name}
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
              {session.data?.actor}
              <small>
                {canWrite ? '관리자' : '조회 전용'} · v{session.data?.version}
              </small>
            </span>
          </div>
          {session.data?.mode === 'token' && (
            <button className="sidebar-search" onClick={() => void changeToken('')}>
              <LogOut size={15} /> 연결 해제
            </button>
          )}
        </div>
      </aside>
      <div className="work-area">
        <header className="context-bar">
          <div className="context-left">
            <button
              aria-label="워크스페이스 전환"
              className={'workspace-pill ' + workspace}
              disabled={session.data?.workspaces.length !== 2}
              onClick={() => {
                if (session.data?.workspaces.length !== 2) return;
                update({
                  workspace: workspace === 'demo' ? 'live' : 'demo',
                  service: undefined,
                  environment: undefined,
                  ...Object.fromEntries(dimensionKeys.map((key) => [key, undefined])),
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
            <button
              className="button secondary"
              onClick={() => {
                const f = dashboard.data?.window.from ?? Date.now() - 3600000,
                  t = dashboard.data?.window.to ?? Date.now();
                setFromInput(new Date(f).toISOString().slice(0, 16));
                setToInput(new Date(t).toISOString().slice(0, 16));
                setTimeOpen(true);
              }}
            >
              {url.has('from') ? '고정 시간 (UTC)' : '시간 지정 (UTC)'}
            </button>
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
            {session.data?.mode === 'token' && (
              <button
                className="icon-button mobile-disconnect"
                aria-label="연결 해제"
                title={`${session.data.actor} · ${canWrite ? '관리자' : '조회 전용'} 연결 해제`}
                onClick={() => void changeToken('')}
              >
                <LogOut size={15} />
              </button>
            )}
          </div>
        </header>
        <ResourceScope
          params={params}
          resources={inventory.data?.items ?? []}
          update={update}
          truncated={inventory.data?.truncated ?? false}
        />
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
                  onClick={() => select({ type: 'briefing' })}
                >
                  <Sparkles size={15} /> 근거 브리핑
                </button>
              )}
              {page === 'alerts' && (
                <button
                  className="button"
                  disabled={!props || !canWrite}
                  onClick={() => setForm({ kind: 'rule' })}
                >
                  <Plus size={15} /> 규칙 만들기
                </button>
              )}
            </div>
          </div>
          {!canWrite && (
            <div className="access-readonly" role="status">
              조회 전용으로 연결했습니다. 규칙·장애·설정 변경에는 관리자 권한이 필요합니다.
            </div>
          )}
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
                    ...Object.fromEntries(dimensionKeys.map((key) => [key, undefined])),
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
              <button className="text-button" onClick={() => void changeToken('')}>
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
              {props.data.truncated && (
                <div className="notice">
                  목록은 조회 상한 내 표본입니다. 차트·API·오류 분석은 보존된 전체 시간 범위를
                  집계하며 그룹 상한을 별도로 표시합니다. 로그는 다음 페이지로 더 탐색할 수
                  있습니다.
                </div>
              )}
              <PageComponent {...props} />
            </>
          )}
          <div className="saved-view-bar">
            <button className="text-button" onClick={saveView}>
              현재 조사 저장
            </button>
            {savedViews.map((v) => (
              <button
                className="scope-chip"
                key={v.name}
                onClick={() => {
                  history.pushState(null, '', '?' + v.query);
                  setUrl(new URLSearchParams(v.query));
                }}
              >
                {v.name}
              </button>
            ))}
            {url.has('from') && (
              <button
                className="text-button"
                onClick={() => update({ from: undefined, to: undefined })}
              >
                실시간 범위로 복귀
              </button>
            )}
          </div>
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
      {timeOpen && (
        <Dialog title="조사 시간 지정 (UTC)" onClose={() => setTimeOpen(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              const from = Date.parse(fromInput + 'Z'),
                to = Date.parse(toInput + 'Z');
              if (
                !Number.isFinite(from) ||
                !Number.isFinite(to) ||
                from > to ||
                to - from > 7 * 86400000
              ) {
                setToast('시간은 순서대로, 최대 7일 범위로 지정하세요.');
                return;
              }
              update({ from: String(from), to: String(to) });
              setTimeOpen(false);
            }}
          >
            <label>
              시작 UTC
              <input
                required
                type="datetime-local"
                value={fromInput}
                onChange={(e) => setFromInput(e.target.value)}
              />
            </label>
            <label>
              종료 UTC
              <input
                required
                type="datetime-local"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
              />
            </label>
            <label>
              표시 시간대
              <select
                aria-label="조사 표시 시간대"
                value={url.get('timezone') === 'UTC' ? 'UTC' : 'Asia/Seoul'}
                onChange={(e) => update({ timezone: e.target.value })}
              >
                <option value="Asia/Seoul">한국 · UTC+09</option>
                <option value="UTC">UTC</option>
              </select>
            </label>
            <p className="muted">입력 범위는 UTC이며 로그와 차트는 선택한 시간대로 표시합니다.</p>
            <button className="button">시간 적용</button>
          </form>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {form && props && canWrite && (
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
          onClose={() => select(null)}
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
                    select({ type: 'service', name: s.name });
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
