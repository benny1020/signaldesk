import { ShieldCheck } from 'lucide-react';
import type { AggregateResult, Series } from '../../../../packages/contracts/src/index';
import { Panel, Empty, number, time, Chart, ChartBoundary } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback } from './shared';
import { EvidenceAssistant } from './EvidenceAssistant';
export function OperationalAnalysis(p: PageProps) {
  const logs = useData<AggregateResult>('/api/analysis/logBuckets', p),
    errors = useData<AggregateResult>('/api/analysis/errorGroups', p);
  const step = logs.data?.stepMs ?? 60000,
    start = Math.floor(p.data.window.from / step) * step,
    count = Math.ceil((p.data.window.to - start) / step) + 1;
  const services = [...new Set(logs.data?.rows.map((r) => String(r.service)) ?? [])];
  const series: Series[] = services.map((service) => ({
    name: service,
    unit: '오류 로그',
    points: Array.from({ length: count }, (_, i) => {
      const t = start + i * step;
      return [
        t,
        (logs.data?.rows ?? [])
          .filter((r) => r.service === service && r.level === 'error' && Number(r.bucket) === t)
          .reduce((n, r) => n + Number(r.count), 0),
      ] as [number, number];
    }),
  }));
  return (
    <>
      <div className="investigation-intro">
        <ShieldCheck size={22} />
        <div>
          <strong>선택한 시간 전체의 오류를 조사합니다</strong>
          <p>로그 목록의 페이지 크기와 별도로 서버가 전체 보존 범위를 집계합니다.</p>
        </div>
      </div>
      <Feedback error={logs.error ?? errors.error} />
      {(logs.data?.truncated || errors.data?.truncated) && (
        <div className="notice">집계 그룹 상한에 도달했습니다. 서비스·리전을 좁히세요.</div>
      )}
      <Panel
        title="서비스별 오류 발생"
        meta={`${new Date(p.data.window.from).toLocaleString('ko-KR')} ~ ${new Date(p.data.window.to).toLocaleString('ko-KR')}`}
      >
        <ChartBoundary>
          <Chart
            title="전 기간 오류 히트맵"
            series={series}
            heatmap
            height={250}
            onRange={p.onRange}
          />
        </ChartBoundary>
      </Panel>
      <EvidenceAssistant {...p} />
      <Panel title="오류 그룹" meta="서비스·환경·오류 코드·예외 종류·메시지가 같은 로그">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>오류 근거</th>
                <th>서비스 / 환경</th>
                <th className="numeric">발생</th>
                <th>마지막 관측</th>
                <th>조사</th>
              </tr>
            </thead>
            <tbody>
              {errors.data?.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <strong>{String(r.message)}</strong>
                    <small className="cell-detail">
                      {String(r.exception)} {String(r.code)}
                    </small>
                  </td>
                  <td>
                    {String(r.service)}
                    <small className="cell-detail">{String(r.environment)}</small>
                  </td>
                  <td className="numeric">{number(Number(r.count), 0)}</td>
                  <td>{time(Number(r.last_seen))}</td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() =>
                        p.updateScope({
                          page: 'logs',
                          service: String(r.service),
                          environment: String(r.environment),
                          search: String(r.message),
                          level: 'error',
                        })
                      }
                    >
                      로그 조사
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!errors.data?.rows.length && (
          <Empty>선택 범위에 오류 로그가 없습니다. 수집 상태도 확인하세요.</Empty>
        )}
      </Panel>
    </>
  );
}
