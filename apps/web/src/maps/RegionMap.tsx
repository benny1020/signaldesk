import { useId, useState } from 'react';
import { ArrowUpRight, MapPin, CheckCircle2, TriangleAlert, Clock } from 'lucide-react';
import type { ResourceSummary } from '../../../../packages/contracts/src/index';
import { regionalSummary, regionLabel } from '../../../../packages/contracts/src/deployments';
import { Panel, Empty, number } from '../components';
import type { PageProps } from '../Pages';
import land from './world-land.json';
import './region-map.css';

type Region = ReturnType<typeof regionalSummary>[number];
const stateLabel = (r: Region) =>
  r.degraded ? `${r.degraded}개 주의` : r.unknown ? '데이터 지연·미수집' : '정상 관측';
const worldPoint = (longitude: number, latitude: number) => [
  ((longitude + 180) / 360) * 1000,
  ((80 - latitude) / 140) * 400,
];
const insetLabels: Record<string, [number, number]> = {
  'ap-northeast-2': [80, 8],
  'ap-northeast-1': [231, 111],
  'ap-southeast-1': [107, 251],
};

function RegionPin({
  row,
  selected,
  inset = false,
  select,
}: {
  row: Region;
  selected: boolean;
  inset?: boolean;
  select: () => void;
}) {
  const location = row.location!;
  const [x, y] = inset
    ? [((location.longitude - 90) / 60) * 340, ((47 - location.latitude) / 56) * 320]
    : worldPoint(location.longitude, location.latitude);
  const label = inset
    ? insetLabels[row.region]
    : row.region === 'us-east-1'
      ? [163, 183]
      : row.region === 'eu-west-1'
        ? [439, 134]
        : undefined;
  const width = inset ? 108 : 170,
    height = inset ? 51 : 66;
  return (
    <g
      className={`region-pin ${row.status} ${selected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${regionLabel(row.region)} 지도에서 선택, ${stateLabel(row)}, ${row.resources}개 리소스`}
      aria-pressed={selected}
      onClick={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      }}
    >
      {label && (
        <path
          className="region-leader"
          d={`M${x},${y} L${label[0] + width / 2},${label[1] + (y < label[1] ? 0 : height)}`}
        />
      )}
      <circle className="region-pin-hit" cx={x} cy={y} r={inset ? 19 : 24} />
      <circle className="region-pin-ring" cx={x} cy={y} r={inset ? 12 : 15} />
      <circle className="region-pin-core" cx={x} cy={y} r={inset ? 5 : 7} />
      {label && (
        <g className={`region-map-label ${inset ? 'inset-label' : 'world-label'}`}>
          <rect x={label[0]} y={label[1]} width={width} height={height} rx={6} />
          <text className="region-label-name" x={label[0] + 12} y={label[1] + (inset ? 20 : 26)}>
            {location.label}
          </text>
          <text className="region-label-status" x={label[0] + 12} y={label[1] + (inset ? 39 : 51)}>
            {row.degraded ? `${row.degraded}개 주의` : row.unknown ? '데이터 지연' : '정상 관측'}
          </text>
        </g>
      )}
    </g>
  );
}

export function RegionMap({ resources, p }: { resources: ResourceSummary[]; p: PageProps }) {
  const [chosen, setChosen] = useState<string>();
  const [listPage, setListPage] = useState(0);
  const clipId = useId();
  const rows = regionalSummary(resources).sort((a, b) => a.region.localeCompare(b.region));
  const mapped = rows.filter((r) => r.location);
  const unmapped = rows.filter((r) => !r.location);
  const selected =
    rows.find((r) => r.region === chosen) ??
    rows.find((r) => r.region === p.params.region) ??
    rows.find((r) => r.degraded) ??
    rows.find((r) => r.unknown) ??
    mapped[0] ??
    rows[0];
  const ordered = [...mapped, ...unmapped];
  const currentPage = Math.min(listPage, Math.max(0, Math.ceil(rows.length / 12) - 1));
  const regionScope = (region: string) => ({
    region,
    zone: undefined,
    cluster: undefined,
    namespace: undefined,
    instanceId: undefined,
    edge: undefined,
    route: undefined,
  });
  return (
    <Panel
      title="글로벌 리전 지도"
      meta="위치와 관측 상태를 함께 봅니다. 지역을 선택해 배포·로그·요청 흐름을 조사하세요."
      className="region-map-panel"
      action={
        p.params.region && (
          <button
            className="text-button"
            onClick={() => p.updateScope({ ...regionScope(''), region: undefined })}
          >
            모든 리전 보기
          </button>
        )
      }
    >
      <div className="region-map-legend" aria-label="지도 상태 범례">
        <span>
          <CheckCircle2 size={14} className="healthy" /> 정상 관측
        </span>
        <span>
          <TriangleAlert size={14} className="degraded" /> 주의
        </span>
        <span>
          <Clock size={14} className="unknown" /> 데이터 지연·미수집
        </span>
        <small>현재 배포 범위의 리소스 기준</small>
      </div>
      {p.data.inventoryTruncated && (
        <p className="notice">
          인벤토리 상한으로 일부 리소스가 빠졌습니다. 현재 목록의 관측 상태입니다.
        </p>
      )}
      <div className="region-atlas">
        <div className="region-world">
          <span className="map-view-caption">세계 배포 위치</span>
          <svg viewBox="0 0 1000 400" role="group" aria-label="세계 리전 지도">
            <defs>
              <clipPath id={clipId}>
                <rect width="1000" height="400" />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>
              <path
                className="map-graticule"
                d="M0,57H1000 M0,143H1000 M0,229H1000 M0,314H1000 M167,0V400 M333,0V400 M500,0V400 M667,0V400 M833,0V400"
              />
              <path className="map-land" d={land.path} />
              {!!mapped.some((r) => insetLabels[r.region]) && (
                <g aria-hidden="true" className="asia-locator">
                  <rect x="750" y="94" width="167" height="160" rx="7" />
                  <text x="764" y="283">
                    아시아 확대
                  </text>
                </g>
              )}
              {mapped.map((r) => (
                <RegionPin
                  key={r.region}
                  row={r}
                  selected={selected?.region === r.region}
                  select={() => setChosen(r.region)}
                />
              ))}
            </g>
          </svg>
        </div>
        <div className="region-inset">
          <span className="map-view-caption">동아시아·동남아시아 확대</span>
          <svg viewBox="0 0 340 320" role="group" aria-label="아시아 리전 확대 지도">
            <path
              className="map-graticule"
              d="M0,97H340 M0,211H340 M57,0V320 M170,0V320 M283,0V320"
            />
            <g transform="matrix(2.04 0 0 2 -1530 -188.5714)">
              <path className="map-land" d={land.path} />
            </g>
            {mapped
              .filter((r) => insetLabels[r.region])
              .map((r) => (
                <RegionPin
                  key={r.region}
                  row={r}
                  selected={selected?.region === r.region}
                  inset
                  select={() => setChosen(r.region)}
                />
              ))}
          </svg>
        </div>
      </div>
      {!!unmapped.length && (
        <p className="map-unmapped">
          <MapPin size={14} /> 위치 미등록 {unmapped.length}개 리전은 아래 목록에서 확인하세요.
          위치를 추정하지 않습니다.
        </p>
      )}
      <div className="map-region-list" aria-label="리전 선택">
        {ordered.slice(currentPage * 12, currentPage * 12 + 12).map((r) => (
          <button
            key={r.region}
            className={`map-region-choice ${r.status}`}
            aria-pressed={selected?.region === r.region}
            onClick={() => setChosen(r.region)}
          >
            <span className="map-region-choice-title">
              <span className="map-status-dot" />
              {regionLabel(r.region)}
            </span>
            <span className="map-region-code">{r.region}</span>
            <span className="map-region-state">{stateLabel(r)}</span>
            <small>
              {r.resources}개 리소스{r.location ? '' : ' / 위치 미등록'}
            </small>
          </button>
        ))}
      </div>
      {rows.length > 12 && (
        <div className="map-pagination">
          <span>
            {rows.length}개 관측 리전 / {currentPage + 1}페이지
          </span>
          <button
            className="text-button"
            disabled={!currentPage}
            onClick={() => setListPage(currentPage - 1)}
          >
            이전 리전
          </button>
          <button
            className="text-button"
            disabled={(currentPage + 1) * 12 >= rows.length}
            onClick={() => setListPage(currentPage + 1)}
          >
            다음 리전
          </button>
        </div>
      )}
      {selected ? (
        <div className="map-region-detail" aria-label="선택한 리전 상세">
          <div className="map-detail-summary" aria-live="polite">
            <h3>
              {regionLabel(selected.region)}
              <span>{stateLabel(selected)}</span>
            </h3>
            <p>
              {selected.services}개 서비스 / {selected.applications}개 앱 인스턴스 /{' '}
              {selected.hosts}개 호스트
            </p>
            {!!selected.degraded && !!selected.unknown && (
              <p>{selected.unknown}개 리소스 데이터 지연·미수집</p>
            )}
          </div>
          <dl className="map-detail-metrics">
            <div>
              <dt>서비스 요청 합계</dt>
              <dd>
                {number(selected.rate)} <small>{selected.rate === null ? '' : 'req/s'}</small>
              </dd>
            </div>
            <div>
              <dt>가중 오류율</dt>
              <dd>
                {number(selected.error, 2)}
                <small>{selected.error === null ? '' : '%'}</small>
              </dd>
            </div>
            <div>
              <dt>최대 인스턴스 p95</dt>
              <dd>
                {number(selected.latency)} <small>{selected.latency === null ? '' : 'ms'}</small>
              </dd>
            </div>
          </dl>
          <div className="map-detail-actions">
            <button
              className="button secondary"
              onClick={() => p.updateScope(regionScope(selected.region))}
            >
              지역 배포 보기 <ArrowUpRight size={14} />
            </button>
            <button
              className="button primary"
              onClick={() =>
                p.updateScope({
                  ...regionScope(selected.region),
                  page: 'overview',
                  flowView: 'all',
                })
              }
            >
              요청 흐름 보기 <ArrowUpRight size={14} />
            </button>
            <button
              className="text-button"
              onClick={() => p.updateScope({ ...regionScope(selected.region), page: 'logs' })}
            >
              지역 로그 보기 <ArrowUpRight size={13} />
            </button>
          </div>
        </div>
      ) : (
        <Empty>
          현재 범위의 관측 리소스가 없습니다. 리전 정보와 함께 수집하면 지도에 표시됩니다.
        </Empty>
      )}
      <div className="map-footnote">
        <span>
          대표 위치 표시, 실제 시설 위치 아님. 요청 합계는 서비스 호출의 합으로 중복 호출을
          포함합니다.
        </span>
        <a
          href="https://www.naturalearthdata.com/about/terms-of-use/"
          target="_blank"
          rel="noreferrer"
        >
          지도: Natural Earth
        </a>
      </div>
    </Panel>
  );
}
