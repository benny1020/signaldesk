import { useState } from 'react';

import { Search } from 'lucide-react';
import type { AggregateResult } from '../../../../packages/contracts/src/index';
import { Panel, Empty, number } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback } from './shared';
export function APIAnalysis(p: PageProps) {
  const q = useData<AggregateResult>('/api/analysis/apis', p),
    [search, setSearch] = useState('');
  const rows =
    q.data?.rows.filter((r) =>
      [r.service, r.route, r.region].join(' ').toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <Panel title="API 경로별 조사" meta="현재 범위의 관측 server/root span 전체 집계">
      <Feedback error={q.error} />
      <div className="log-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="API 경로 검색"
            placeholder="API 경로·서비스·리전 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {q.data?.truncated && (
        <div className="notice">API 그룹 1,000개 상한입니다. 서비스 또는 리전을 좁히세요.</div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>API 경로</th>
              <th>서비스 / 리전</th>
              <th className="numeric">관측 요청</th>
              <th className="numeric">실패율</th>
              <th className="numeric">평균 지연</th>
              <th className="numeric">최대 지연</th>
              <th>조사</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <strong>{String(r.route)}</strong>
                  <small className="cell-detail">{String(r.method)}</small>
                </td>
                <td>
                  {String(r.service)}
                  <small className="cell-detail">{String(r.region ?? 'unknown')}</small>
                </td>
                <td className="numeric">{number(Number(r.count), 0)}</td>
                <td className={'numeric ' + (Number(r.errors) > 0 ? 'danger-text' : '')}>
                  {number((100 * Number(r.errors)) / Number(r.count), 2)}%
                </td>
                <td className="numeric">{number(Number(r.average_ms), 1)} ms</td>
                <td className="numeric">{number(Number(r.maximum_ms), 1)} ms</td>
                <td>
                  <button
                    className="text-button"
                    onClick={() =>
                      p.updateScope({
                        page: 'traces',
                        service: String(r.service),
                        environment: String(r.environment),
                        region: r.region ? String(r.region) : undefined,
                        route: String(r.route),
                      })
                    }
                  >
                    트레이스 조사
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <Empty>API 관측 자료가 없습니다. http.route와 server span을 수집하세요.</Empty>
      )}
    </Panel>
  );
}
