import { lazy, Suspense, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Network,
  Search,
  Maximize2,
  Rows3,
  ExternalLink,
  AlertTriangle,
  ArrowUpRight,
} from 'lucide-react';
import type {
  RequestFlow as Flow,
  FlowEdge,
  FlowNode,
  Series,
} from '../../../../packages/contracts/src/index';
import type { PageProps } from '../Pages';
import { request, queryString } from '../api';
import { Chart, Empty, number, time } from '../components';
import { DependencyRules } from './DependencyRules';
const Canvas = lazy(() => import('./FlowCanvas'));
const Heatmap = lazy(() => import('./LatencyHeatmap'));
export function RequestFlow(p: PageProps) {
  const params = { ...p.params, from: p.data.window.from, to: p.data.window.to };
  const query = useQuery({
    queryKey: ['request-flow', params],
    queryFn: ({ signal }) => request<Flow>('/api/request-flow?' + queryString(params), { signal }),
    refetchInterval: p.paused ? false : 10000,
    retry: false,
  });
  const [map, setMap] = useState(true),
    [search, setSearch] = useState(''),
    [focus, setFocus] = useState<FlowNode | null>(null),
    [regionsExpanded, setRegionsExpanded] = useState(false);
  const mode = String(p.params.flowView ?? 'all');
  const data = query.data,
    selected = data?.edges.find((e) => e.id === data.selectedEdge);
  const edges = useMemo(
    () =>
      data?.edges.filter((e) => {
        const source = data.nodes.find((n) => n.id === e.source),
          target = data.nodes.find((n) => n.id === e.target);
        const focused = (n?: FlowNode) =>
          n?.name === focus?.name &&
          n?.environment === focus?.environment &&
          n?.module === focus?.module &&
          (focus?.region === 'all' || n?.region === focus?.region);
        return (
          (mode === 'all' || mode === e.direction || (mode === 'failures' && e.errors > 0)) &&
          (!focus || focused(source) || focused(target)) &&
          [source?.name, target?.name, source?.region, target?.region, e.route]
            .join(' ')
            .toLowerCase()
            .includes(search.toLowerCase())
        );
      }) ?? [],
    [data, mode, focus, search],
  );
  const select = (e: FlowEdge) =>
    p.updateScope({ edge: e.id, from: String(p.data.window.from), to: String(p.data.window.to) });
  const node = (id?: string) => data?.nodes.find((n) => n.id === id);
  const graph = useMemo(() => {
    if (!data || regionsExpanded) return { data, edges, selected };
    const groups = new Map<string, FlowNode[]>(),
      mapping = new Map<string, string>();
    for (const n of data.nodes) {
      const k = JSON.stringify([n.type, n.name, n.environment, n.module]);
      groups.set(k, [...(groups.get(k) ?? []), n]);
    }
    const nodes = [...groups.values()].map((group) => {
      const n = group[0];
      for (const x of group) mapping.set(x.id, n.id);
      const regions = [...new Set(group.map((x) => x.region))];
      return { ...n, region: regions.length > 1 ? 'all' : n.region, regions };
    });
    const convert = (e: FlowEdge) => ({
      ...e,
      source: mapping.get(e.source)!,
      target: mapping.get(e.target)!,
    });
    return {
      data: { ...data, nodes },
      edges: edges.map(convert),
      selected: selected ? convert(selected) : undefined,
    };
  }, [data, edges, selected, regionsExpanded]);
  const inbound = data?.edges.filter((e) => e.direction === 'inbound') ?? [],
    outbound = data?.edges.filter((e) => e.direction === 'outbound') ?? [];
  const total = (items: FlowEdge[], key: 'count' | 'errors' | 'retries') =>
    items.reduce((n, e) => n + e[key], 0);
  const percent = (n: number, d: number) => (d ? number((n / d) * 100) + '%' : '—');
  const series = (
    name: string,
    unit: string,
    value: (b: Flow['buckets'][number]) => number,
  ): Series => ({
    name,
    unit,
    window: { from: data!.from, to: data!.to },
    stepMs: data!.stepMs,
    points: data!.buckets.map((b) => [b.timestamp, value(b)]),
  });
  return (
    <div className="request-flow-workspace">
      <div className="flow-brief">
        <div>
          <Network size={24} />
          <div>
            <strong>고객 요청에서 외부 의존성까지</strong>
            <p>우리 API의 응답과 하위 호출 결과를 연결해 봅니다.</p>
          </div>
        </div>
        <button className="text-button" onClick={() => p.navigate('metrics')}>
          운영 지표 요약 <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="flow-summary">
        <div>
          <span>진입 요청 관측</span>
          <strong>
            {data ? number(total(inbound, 'count'), 0) : '—'}
            <small>건</small>
          </strong>
        </div>
        <ArrowRight size={19} />
        <div>
          <span>우리 API 실패</span>
          <strong>{data ? percent(total(inbound, 'errors'), total(inbound, 'count')) : '—'}</strong>
        </div>
        <ArrowRight size={19} />
        <div>
          <span>하위 호출 시도</span>
          <strong>
            {data ? number(total(outbound, 'count'), 0) : '—'}
            <small>건</small>
          </strong>
        </div>
        <div>
          <span>재전송 관측</span>
          <strong>
            {data ? number(total(outbound, 'retries'), 0) : '—'}
            <small>건</small>
          </strong>
        </div>
        <p>
          저장된 스팬 기준
          <br />
          전체 트래픽 추정 없음
        </p>
      </div>
      {query.error && (
        <div className="notice" role="alert">
          {query.error.message}{' '}
          <button className="text-button" onClick={() => p.updateScope({ edge: undefined })}>
            연결 선택 초기화
          </button>
        </div>
      )}
      <div className="flow-toolbar">
        <div className="flow-segment" aria-label="호출 방향">
          {[
            ['all', '전체 흐름'],
            ['inbound', '진입 API'],
            ['outbound', '하위 호출'],
            ['failures', '실패 관측'],
          ].map(([key, title]) => (
            <button
              key={key}
              aria-pressed={mode === key}
              onClick={() => {
                setFocus(null);
                p.updateScope({ flowView: key === 'all' ? undefined : key });
              }}
            >
              {title}
            </button>
          ))}
        </div>
        <label className="flow-search">
          <Search size={15} />
          <input
            aria-label="요청 연결 검색"
            placeholder="서비스·호스트·리전·API 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button className="button secondary" onClick={() => setMap(!map)}>
          {map ? <Rows3 size={16} /> : <Maximize2 size={16} />} {map ? '목록 보기' : '지도 보기'}
        </button>
      </div>
      {focus && (
        <div className="flow-focus">
          {focus.name}의 연결{' '}
          {focus.region !== 'unobserved' &&
            ' / ' + (focus.region === 'all' ? '모든 리전' : focus.region)}
          <button className="text-button" onClick={() => setFocus(null)}>
            전체로 복귀
          </button>
          {focus.type === 'workload' && (
            <button
              className="text-button"
              onClick={() =>
                p.updateScope({
                  page: 'services',
                  service: focus.name,
                  environment: focus.environment,
                  region: focus.region === 'all' ? undefined : focus.region,
                  module: focus.module,
                  instanceId: undefined,
                  cluster: undefined,
                  namespace: undefined,
                  zone: undefined,
                  edge: undefined,
                })
              }
            >
              서비스 지표
            </button>
          )}
        </div>
      )}
      {data?.truncated && (
        <div className="notice">
          <AlertTriangle size={16} /> 집계 결과가 1,000개 연결 상한에 도달했습니다.
          리전·서비스·시간을 좁히세요. 합계는 표시된 연결 범위입니다.
        </div>
      )}
      {query.isPending ? (
        <Empty>호출 관계와 고객 응답을 연결하고 있습니다…</Empty>
      ) : data && !data.edges.length ? (
        <div className="flow-onboarding">
          <Network size={35} />
          <h2>진입·하위 호출 스팬을 연결하세요</h2>
          <p>
            SERVER와 CLIENT 종류, trace ID와 parent span ID가 필요합니다. 미계측 구간을 성공으로
            표시하지 않습니다.
          </p>
          <button className="button" onClick={() => p.navigate('connections')}>
            수집 연결 확인
          </button>
          <a
            href="https://github.com/benny1020/signaldesk/blob/main/docs/REQUEST_FLOW_INSTRUMENTATION.md"
            target="_blank"
            rel="noreferrer"
          >
            계측 가이드 <ExternalLink size={14} />
          </a>
        </div>
      ) : (
        data && (
          <>
            <div className={`flow-investigation ${map ? '' : 'is-table'}`}>
              <section className="flow-map-surface">
                <div className="flow-section-head">
                  <div>
                    <h2>{map ? '요청 흐름 지도' : '호출 연결 목록'}</h2>
                    <p>{edges.length}개 route 연결 · 서비스는 환경·리전·모듈 단위로 묶음</p>
                  </div>
                  <div className="flow-key">
                    <span>
                      <i />
                      계측된 상대
                    </span>
                    <span>
                      <i className="virtual" />
                      상대 내부 미관측
                    </span>
                    <span>
                      <i className="failure" />
                      실패 관측
                    </span>
                  </div>
                </div>
                {map ? (
                  <>
                    <div className="flow-layout-toggle">
                      <button
                        className="text-button"
                        aria-pressed={regionsExpanded}
                        onClick={() => {
                          setFocus(null);
                          setRegionsExpanded(!regionsExpanded);
                        }}
                      >
                        {regionsExpanded ? '서비스별로 묶기' : '리전별로 펼치기'}
                      </button>
                      <span>선택 시 해당 route·리전의 수치 확인</span>
                    </div>
                    <Suspense fallback={<Empty>지도를 불러오고 있습니다…</Empty>}>
                      <Canvas
                        data={graph.data!}
                        edges={graph.edges}
                        selected={graph.selected}
                        onSelect={select}
                        onFocus={setFocus}
                      />
                    </Suspense>
                  </>
                ) : (
                  <ConnectionTable data={data} edges={edges} selected={selected} select={select} />
                )}
              </section>
              <aside className="flow-inspector" aria-label="선택한 호출 연결">
                {selected ? (
                  <>
                    <div className="flow-inspector-tag">
                      {selected.direction === 'outbound' ? '하위 호출 조사' : '진입 API 조사'}
                      <span>{selected.protocol}</span>
                    </div>
                    <h2>
                      {node(selected.source)?.name}
                      <ArrowRight size={16} />
                      {node(selected.target)?.name}
                    </h2>
                    <p className="flow-route">
                      {selected.method} {selected.route}
                    </p>
                    <div className="flow-selected-place">
                      {node(selected.source)?.region} → {node(selected.target)?.region}
                      <br />
                      {node(selected.source)?.module} · {node(selected.source)?.environment}
                    </div>
                    <div className="flow-result">
                      <strong>{percent(selected.errors, selected.count)}</strong>
                      <span>관측 실패율 / {number(selected.count, 0)}건</span>
                    </div>
                    <dl className="flow-facts">
                      <div>
                        <dt>관측 p50 / p95</dt>
                        <dd>
                          {number(selected.p50Ms, 0)} / {number(selected.p95Ms, 0)}ms
                        </dd>
                      </div>
                      <div>
                        <dt>재전송 / timeout</dt>
                        <dd>
                          {selected.retries} / {selected.timeouts}건
                        </dd>
                      </div>
                      <div>
                        <dt>4xx / 429</dt>
                        <dd>
                          {selected.clientErrors} / {selected.throttled}건
                        </dd>
                      </div>
                      <div>
                        <dt>상대 SERVER 연결</dt>
                        <dd>
                          {selected.direction === 'outbound'
                            ? `${selected.paired} / ${selected.count}건`
                            : '진입 쪽 관측'}
                        </dd>
                      </div>
                    </dl>
                    {selected.direction === 'outbound' && (
                      <div className="flow-customer">
                        <h3>관측 진입 API 응답</h3>
                        <div>
                          <span>하위 실패 + API 실패</span>
                          <strong>{selected.impactedEntries}건</strong>
                        </div>
                        <div>
                          <span>하위 실패 + API 성공</span>
                          <strong>{selected.recoveredEntries}건</strong>
                        </div>
                        <p>
                          진입 SERVER {selected.entryRequests}개 요청과 연결. 미계측·유실 구간은
                          근거 없음이며 원인 판정은 아닙니다.
                        </p>
                      </div>
                    )}
                    {selected.direction === 'outbound' && (
                      <details className="flow-local-response">
                        <summary>
                          직접 호출 서비스 API 응답 · {selected.parentRequests}개 연결
                        </summary>
                        <p>
                          하위 실패 + API 실패 {selected.impactedRequests}건<br />
                          하위 실패 + API 성공 {selected.recoveredRequests}건
                        </p>
                        <p>가장 가까운 상위 SERVER 응답입니다. 진입 API 응답과 다를 수 있습니다.</p>
                      </details>
                    )}
                    {node(selected.target)?.type === 'dependency' && (
                      <div className="flow-boundary">
                        외부·미계측 대상입니다. 지연과 실패는 호출한 쪽에서 측정했으며 상대 내부
                        가용성은 알 수 없습니다.
                      </div>
                    )}
                    <button
                      className="button secondary"
                      onClick={() => {
                        const n =
                          node(selected.source)?.type === 'workload'
                            ? node(selected.source)
                            : node(selected.target);
                        p.updateScope({
                          page: 'logs',
                          service: n?.name,
                          environment: n?.environment,
                          region: n?.region,
                          module: n?.module,
                          instanceId: undefined,
                          cluster: undefined,
                          namespace: undefined,
                          zone: undefined,
                          edge: undefined,
                        });
                      }}
                    >
                      관련 서비스 로그 <ArrowUpRight size={14} />
                    </button>
                  </>
                ) : (
                  <Empty>지도 또는 목록에서 연결을 선택하세요.</Empty>
                )}
              </aside>
            </div>
            {!edges.length && (
              <div className="empty">필터에 맞는 연결이 없습니다. 검색어나 방향을 바꾸세요.</div>
            )}
            {selected && (
              <>
                <div className="flow-charts">
                  <Suspense fallback={<Empty>지연 분포를 불러옵니다…</Empty>}>
                    <Heatmap data={data} onRange={p.onRange} />
                  </Suspense>
                  <section className="flow-trends">
                    <div className="flow-section-head">
                      <div>
                        <h3>선택한 호출의 변화</h3>
                        <p>결측 구간은 연결하지 않습니다.</p>
                      </div>
                    </div>
                    <Chart
                      title="관측 p95 지연"
                      height={125}
                      series={[series('관측 p95', 'ms', (b) => b.p95Ms)]}
                      onRange={p.onRange}
                    />
                    <Chart
                      title="관측 실패율"
                      height={110}
                      series={[series('실패율', '%', (b) => (b.errors / b.count) * 100)]}
                      onRange={p.onRange}
                    />
                  </section>
                </div>
                <section className="flow-evidence">
                  <div className="flow-section-head">
                    <div>
                      <h2>호출 근거</h2>
                      <p>실패·긴 지연 순 상위 12개 스팬 · 전체 요청의 대표 표본이 아닙니다.</p>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>시간 / 리전</th>
                          <th>호출 결과</th>
                          <th>하위 지연</th>
                          <th>호출 서비스 API</th>
                          <th>진입 API 응답</th>
                          <th>재전송</th>
                          <th>근거</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.evidence.map((e) => (
                          <tr key={e.traceId + e.spanId}>
                            <td>
                              {time(e.timestamp)}
                              <small>
                                {e.region} / {e.instanceId}
                              </small>
                            </td>
                            <td>
                              <span className={`flow-outcome ${e.failed ? 'failed' : ''}`}>
                                {e.failed ? '실패' : '성공'}
                              </span>{' '}
                              {e.errorType ?? e.statusCode ?? '상태 미수집'}
                            </td>
                            <td className="numeric">{number(e.durationMs, 0)}ms</td>
                            <td>
                              {e.parentFailed === null
                                ? '연결 근거 없음'
                                : e.parentFailed
                                  ? '실패'
                                  : '성공'}
                              {e.parentDurationMs !== null && (
                                <small>
                                  {number(e.parentDurationMs, 0)}ms / {e.parentRoute}
                                </small>
                              )}
                            </td>
                            <td>
                              {e.entryFailed === null
                                ? '연결 근거 없음'
                                : e.entryFailed
                                  ? '실패'
                                  : '성공'}
                              {e.entryService && (
                                <small>
                                  {e.entryService} / {number(e.entryDurationMs ?? 0, 0)}ms
                                </small>
                              )}
                            </td>
                            <td>{e.resend}</td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => p.select({ type: 'trace', id: e.traceId })}
                              >
                                트레이스 열기 <ArrowUpRight size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
            <details className="flow-method">
              <summary>관측 기준과 누락 가능성</summary>
              <p>
                수집된 SERVER·CLIENT 스팬을 기준으로 계산합니다. 상대 스팬이 있으면 한 번만 세고,
                없으면 미계측 노드로 표시합니다. 표본 추출·수집 유실·시간창 경계 때문에 상대가 빠질
                수도 있습니다. 최근 스팬 identity로 중복을 제거하며, 응답 연결은 같은 trace·환경 내
                최대 16단계를 따라 호출 서비스 SERVER와 루트 또는 신뢰된 entry 표시 SERVER를
                구분합니다. 진입 근거가 없으면 최종 응답을 추정하지 않습니다. p95는 이 관측 집합의
                실제 순위 값이고 전체 고객 트래픽의 p95가 아닙니다. 재전송에는 HTTP redirect도
                포함될 수 있습니다.
              </p>
            </details>
            <DependencyRules p={p} data={data} selected={selected} />
          </>
        )
      )}
    </div>
  );
}
function ConnectionTable({
  data,
  edges,
  selected,
  select,
}: {
  data: Flow;
  edges: FlowEdge[];
  selected?: FlowEdge;
  select: (e: FlowEdge) => void;
}) {
  const name = (id: string) => data.nodes.find((n) => n.id === id)?.name;
  return (
    <div className="table-scroll flow-connection-table">
      <table>
        <thead>
          <tr>
            <th>호출 연결 / route</th>
            <th>관측 호출</th>
            <th>실패율</th>
            <th>p95</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => (
            <tr key={e.id} className={selected?.id === e.id ? 'selected' : ''}>
              <td>
                <button onClick={() => select(e)} className="text-button">
                  {name(e.source)} → {name(e.target)}
                </button>
                <small>
                  {e.method} {e.route}
                </small>
              </td>
              <td>{number(e.count, 0)}</td>
              <td>{number((e.errors / e.count) * 100)}%</td>
              <td>{number(e.p95Ms, 0)}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
