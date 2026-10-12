import { useState } from 'react';
import { Globe, ArrowUpRight } from 'lucide-react';
import type { ResourceSummary } from '../../../packages/contracts/src/index';
import { regionalComparison, regionLabel } from '../../../packages/contracts/src/deployments';
import { Panel, Badge, number, Empty, Chart, ChartBoundary, time } from './components';
import type { PageProps } from './Pages';
export const resourceLabels = {
  region: '리전',
  module: '모듈',
  cluster: '클러스터',
  namespace: '네임스페이스',
  zone: '가용 영역',
  instanceId: '인스턴스',
} as const;
export function ResourceScope({
  params,
  resources,
  update,
  truncated,
}: {
  params: Record<string, string | number | undefined>;
  resources: ResourceSummary[];
  update: (patch: Record<string, string | undefined>) => void;
  truncated: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = Object.keys(resourceLabels).some((key) => params[key]);
  return (
    <div className="resource-context" aria-label="배포 범위">
      <span className="scope-caption">
        <Globe size={15} /> 배포 범위
      </span>
      {Object.entries(resourceLabels)
        .filter(([key]) => key === 'region' || expanded || params[key])
        .map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <select
              aria-label={label + ' 필터'}
              value={String(params[key] ?? '')}
              onChange={(e) => update({ [key]: e.target.value })}
            >
              <option value="">전체</option>
              {[
                ...new Set([
                  ...(params[key] ? [String(params[key])] : []),
                  ...resources
                    .filter((r) =>
                      ['service', 'environment', ...Object.keys(resourceLabels)]
                        .filter((k) => k !== key)
                        .every((k) => !params[k] || r[k as keyof ResourceSummary] === params[k]),
                    )
                    .map((r) => r[key as keyof typeof resourceLabels]),
                ]),
              ]
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {value === 'unknown'
                      ? '미지정 (unknown)'
                      : key === 'region' && regionLabel(value) !== value
                        ? `${regionLabel(value)} (${value})`
                        : value}
                  </option>
                ))}
            </select>
          </label>
        ))}
      <button
        className="text-button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '고급 필터 접기' : '모듈·인스턴스 필터'}
      </button>
      {active && (
        <button
          className="text-button"
          onClick={() =>
            update(Object.fromEntries(Object.keys(resourceLabels).map((key) => [key, undefined])))
          }
        >
          범위 해제
        </button>
      )}
      {truncated && <span className="scope-limit">목록 상한 도달</span>}
    </div>
  );
}
export function Deployments(p: PageProps) {
  const [showRetired, setShowRetired] = useState(false),
    [page, setPage] = useState(0),
    [search, setSearch] = useState('');
  const all = p.data.resources,
    resources = all.filter(
      (r) =>
        (showRetired || !r.retired) &&
        [r.service, r.module, r.region, r.instanceId, r.host ?? ''].some((value) =>
          value.toLowerCase().includes(search.toLowerCase()),
        ),
    );
  const regions = [...new Set(resources.filter((r) => !r.retired).map((r) => r.region))].sort(),
    parts = regions.map((region) => {
      const rows = resources.filter((r) => r.region === region && !r.retired),
        rate = rows.reduce((sum, r) => sum + (r.requestRate ?? 0), 0),
        redRows = rows.filter(
          (r) => !r.host || r.requestRate !== null || r.errorPct !== null || r.latency !== null,
        ),
        weighted = redRows.filter((r) => r.requestRate !== null && r.errorPct !== null),
        weight = weighted.reduce((sum, r) => sum + r.requestRate!, 0),
        latencies = rows.flatMap((r) => (r.latency === null ? [] : [r.latency]));
      return {
        region,
        rows,
        rate: rows.some((r) => r.requestRate !== null) ? rate : null,
        error:
          weight && weighted.length === redRows.length
            ? weighted.reduce((sum, r) => sum + r.requestRate! * r.errorPct!, 0) / weight
            : null,
        latency: latencies.length ? Math.max(...latencies) : null,
        unknown: rows.filter((r) => r.status === 'unknown').length,
        degraded: rows.filter((r) => r.status === 'degraded').length,
      };
    });
  const total = resources.length,
    selectedPage = Math.min(page, Math.max(0, Math.ceil(total / 50) - 1)),
    comparison = regionalComparison(resources);
  return (
    <>
      <div className="deployment-summary">
        <div>
          <Globe size={20} />
          <strong>{regions.length}</strong>
          <span>관측 리전</span>
        </div>
        <div>
          <strong>
            {
              new Set(
                resources.filter((r) => r.observedApplication || !r.host).map((r) => r.service),
              ).size
            }
          </strong>
          <span>서비스</span>
        </div>
        <div>
          <strong>
            {
              new Set(
                resources.filter((r) => r.observedApplication || !r.host).map((r) => r.module),
              ).size
            }
          </strong>
          <span>모듈</span>
        </div>
        <div>
          <strong>{resources.filter((r) => !r.retired).length}</strong>
          <span>관측 리소스</span>
        </div>
        <p>
          호스트와 서비스 인스턴스를 리전·클러스터까지 구분합니다. 미지정은 실제 리전으로 추정하지
          않습니다.
        </p>
      </div>
      <Panel
        title="같은 서비스의 리전별 상태"
        meta="서비스·환경·모듈을 맞춰 비교합니다. 같은 형상이라도 리전별 상태는 다를 수 있습니다."
      >
        <div className="regional-comparison-toolbar">
          <p>
            리전을 선택하면 해당 서비스의 배포 범위로 이동합니다. 형상 일치는 별도 배포 근거로
            확인하세요.
          </p>
          {p.params.region && (
            <button
              className="text-button"
              onClick={() =>
                p.updateScope({
                  region: undefined,
                  zone: undefined,
                  cluster: undefined,
                  namespace: undefined,
                  instanceId: undefined,
                  edge: undefined,
                })
              }
            >
              모든 리전 비교
            </button>
          )}
        </div>
        {p.data.inventoryTruncated && (
          <p className="notice">
            인벤토리 상한으로 일부 리소스가 빠졌습니다. 현재 목록의 비교 결과입니다.
          </p>
        )}
        {comparison.truncated && (
          <p className="notice">
            {comparison.totalServices}개 서비스·환경·모듈 조합 / {comparison.totalRegions}개 리전 중
            최대 50행·12리전을 표시합니다. 배포 검색이나 범위 필터로 좁히세요.
          </p>
        )}
        <div className="table-scroll">
          <table
            className="regional-comparison"
            style={{ minWidth: 150 + comparison.regions.length * 150 }}
          >
            <thead>
              <tr>
                <th>서비스 / 환경 / 모듈</th>
                {comparison.regions.map((region) => (
                  <th key={region}>
                    {regionLabel(region)}
                    <small>{region}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <strong>{row.service}</strong>
                    <small>
                      {row.environment} / {row.module}
                    </small>
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.region}>
                      {cell.instances ? (
                        <button
                          className={`regional-cell ${cell.status}`}
                          aria-label={`${row.service}, ${row.environment}, ${row.module}, ${regionLabel(cell.region)} 배포 보기`}
                          onClick={() =>
                            p.updateScope({
                              service: row.service,
                              environment: row.environment,
                              module: row.module,
                              region: cell.region,
                              zone: undefined,
                              cluster: undefined,
                              namespace: undefined,
                              instanceId: undefined,
                              edge: undefined,
                            })
                          }
                        >
                          <span className="regional-cell-status">
                            {cell.degraded
                              ? '주의'
                              : cell.unknown
                                ? '데이터 지연·미수집'
                                : '정상 관측'}
                            <small>{cell.instances}개 인스턴스</small>
                          </span>
                          <span>
                            {number(cell.rate)} req/s · {number(cell.error, 2)}
                            {cell.error === null ? '' : '%'}
                          </span>
                          <span>
                            최대 p95 {number(cell.latency)}
                            {cell.latency === null ? '' : ' ms'}
                          </span>
                          {!!cell.unknown && !!cell.degraded && (
                            <span>{cell.unknown}개 데이터 지연·미수집</span>
                          )}
                        </button>
                      ) : (
                        <span className="regional-unobserved">관측 리소스 없음</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!comparison.rows.length && (
          <Empty>서비스 인스턴스를 계측하면 리전별 상태를 비교할 수 있습니다.</Empty>
        )}
      </Panel>
      <Panel
        title="리전 비교"
        meta="현재 배포 범위의 인스턴스 집계 · 데이터 지연을 함께 확인하세요."
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>리전</th>
                <th>인스턴스 / 호스트</th>
                <th>주의 / 데이터 지연</th>
                <th className="numeric">요청 / 초</th>
                <th className="numeric">가중 오류율</th>
                <th className="numeric">최대 인스턴스 p95</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((r) => (
                <tr key={r.region}>
                  <td>
                    <strong>{regionLabel(r.region)}</strong>
                    <small>{r.region}</small>
                  </td>
                  <td>
                    {r.rows.filter((x) => !x.host).length} / {r.rows.filter((x) => x.host).length}
                  </td>
                  <td>
                    <span className={r.degraded ? 'danger-text' : ''}>{r.degraded}개 주의</span> ·{' '}
                    {r.unknown}개 지연
                  </td>
                  <td className="numeric">{number(r.rate)}</td>
                  <td className="numeric">
                    {number(r.error, 2)}
                    {r.error === null ? '' : '%'}
                  </td>
                  <td className="numeric">
                    {number(r.latency)}
                    {r.latency === null ? '' : ' ms'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!parts.length && <Empty>현재 배포 범위에서 관측한 리소스가 없습니다.</Empty>}
      </Panel>
      <Panel title="리전별 요청량" meta="같은 시간 축에서 인스턴스별 요청량을 합산합니다.">
        <ChartBoundary>
          <Chart
            title="리전별 요청량"
            series={Object.entries(p.data.series)
              .filter(([key]) => key.startsWith('request_rate:region:'))
              .map(([, value]) => value)}
            height={230}
          />
        </ChartBoundary>
      </Panel>
      <Panel
        title="배포 인벤토리"
        meta="동일한 인스턴스 이름도 리전·클러스터·모듈이 다르면 별도로 관리합니다."
      >
        <div className="inventory-toolbar">
          <input
            aria-label="배포 검색"
            placeholder="서비스, 모듈, 리전, 인스턴스 검색"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
            />{' '}
            제외한 리소스 표시
          </label>
          <span>
            {total}개 · 현재 페이지 {selectedPage + 1}
          </span>
        </div>
        <div className="table-scroll">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>서비스 / 모듈</th>
                <th>리전 / 가용 영역</th>
                <th>클러스터 / 네임스페이스</th>
                <th>인스턴스 / 호스트</th>
                <th>상태</th>
                <th className="numeric">요청 / 초</th>
                <th className="numeric">오류율</th>
                <th>최근 관측</th>
                <th>운영</th>
              </tr>
            </thead>
            <tbody>
              {resources.slice(selectedPage * 50, (selectedPage + 1) * 50).map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.service}</strong>
                    <small>{r.module}</small>
                  </td>
                  <td>
                    {r.region}
                    <small>{r.zone}</small>
                  </td>
                  <td>
                    {r.cluster}
                    <small>{r.namespace}</small>
                  </td>
                  <td>
                    <strong>{r.instanceId}</strong>
                    <small>{r.host ?? '서비스 인스턴스'}</small>
                  </td>
                  <td>
                    {r.retired ? (
                      <span className="retired-label">관측 제외</span>
                    ) : (
                      <Badge value={r.status} />
                    )}
                  </td>
                  <td className="numeric">{number(r.requestRate)}</td>
                  <td className="numeric">
                    {number(r.errorPct, 2)}
                    {r.errorPct === null ? '' : '%'}
                  </td>
                  <td>{time(r.lastSeen)}</td>
                  <td>
                    <div className="resource-actions">
                      <button className="text-button" onClick={() => p.focusResource(r, 'logs')}>
                        로그 <ArrowUpRight size={12} />
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          void p.mutate('/api/resources/' + r.id, { retired: !r.retired }, 'PATCH')
                        }
                      >
                        {r.retired ? '관측 재개' : '관측 제외'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!total && (
          <Empty>수집 시 리전·모듈·instanceId를 제공하면 이곳에서 구분해 볼 수 있습니다.</Empty>
        )}
        <div className="inventory-footer">
          <span>
            관측 제외는 리소스를 삭제하지 않습니다. 해당 리소스의 알림 평가는 중지하며 기록은
            보존합니다.
          </span>
          <button
            className="button secondary"
            disabled={selectedPage === 0}
            onClick={() => setPage(selectedPage - 1)}
          >
            이전
          </button>
          <button
            className="button secondary"
            disabled={(selectedPage + 1) * 50 >= total}
            onClick={() => setPage(selectedPage + 1)}
          >
            다음
          </button>
        </div>
      </Panel>
    </>
  );
}
