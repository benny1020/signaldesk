import { useState } from 'react';

import { ArrowUpRight, GitBranch } from 'lucide-react';
import type { AggregateResult } from '../../../../packages/contracts/src/index';
import { Panel, Empty, Badge, number, time } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback } from './shared';
export function Relationships(p: PageProps) {
  const q = useData<AggregateResult>('/api/analysis/relations', p),
    [search, setSearch] = useState('');
  const rows =
    q.data?.rows.filter((r) =>
      [r.service, r.target, r.region].join(' ').toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <div className="investigation-intro">
        <GitBranch size={22} />
        <div>
          <strong>관측된 연결 근거로 서비스 관계를 탐색합니다</strong>
          <p>
            peer.service·messaging.destination.name·db.system.name 기반입니다. 관계 부재가 연결
            부재를 뜻하지 않습니다.
          </p>
        </div>
      </div>
      <Feedback error={q.error} />
      <Panel title="서비스·메시징·데이터베이스 관계" meta="현재 시간창에서 관측한 edge">
        <div className="log-toolbar">
          <input
            aria-label="관계 검색"
            placeholder="서비스·대상·리전 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {q.data?.truncated && <div className="notice">관계 그룹 상한입니다. 범위를 좁히세요.</div>}
        <div className="relationship-map" role="list" aria-label="관측 관계">
          {rows.slice(0, 30).map((r, i) => (
            <button
              role="listitem"
              className="relationship-edge"
              key={i}
              onClick={() => p.navigate('traces', String(r.service))}
            >
              <span>
                {String(r.service)}
                <small>{String(r.region ?? 'unknown')}</small>
              </span>
              <div>
                <span>
                  {String(r.type)} · {number(Number(r.count), 0)}건
                </span>
                <ArrowUpRight size={20} />
              </div>
              <strong>{String(r.target)}</strong>
              <Badge value={Number(r.errors) > 0 ? 'degraded' : 'healthy'} />
            </button>
          ))}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>출발</th>
                <th>대상 / 종류</th>
                <th>리전</th>
                <th className="numeric">관측 / 실패</th>
                <th>근거 유효 시간</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.service)}</td>
                  <td>
                    {String(r.target)} / {String(r.type)}
                  </td>
                  <td>{String(r.region ?? 'unknown')}</td>
                  <td className="numeric">
                    {number(Number(r.count), 0)} / {number(Number(r.errors), 0)}
                  </td>
                  <td>
                    {time(Number(r.first_seen))} ~ {time(Number(r.last_seen))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <Empty>관계 속성을 가진 스팬이 없습니다. 수집 coverage와 계측 속성을 확인하세요.</Empty>
        )}
      </Panel>
    </>
  );
}
