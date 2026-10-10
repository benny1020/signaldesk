import { ShieldCheck } from 'lucide-react';

import { Panel, Empty, Badge, number, time } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback } from './shared';
export function PlatformHealth(p: PageProps) {
  const q = useData<{
    deliveryHealth: {
      pending: number;
      failed: number;
      delivered: number;
      oldestPendingAt: number | null;
    };
    health: {
      accepted: number;
      rejected: number;
      storedEvents: number;
      capacity: number;
      backend: string;
      processRole: string;
      workerHeartbeat: number;
      workerError: string | null;
      workers: {
        id: string;
        region?: string;
        lastSeen: number;
        heartbeat: number;
        error: string | null;
      }[];
    };
  }>('/api/connections', p);
  const h = q.data?.health,
    d = q.data?.deliveryHealth;
  return (
    <>
      <div className="investigation-intro">
        <ShieldCheck size={22} />
        <div>
          <strong>관측 플랫폼의 현재 상태를 확인합니다</strong>
          <p>
            이 화면은 과거 조사 시각과 별도로 현재 저장·수집·worker·전달 상태를 표시합니다. 수집
            카운터는 응답한 API 프로세스 기준입니다.
          </p>
        </div>
      </div>
      <Feedback error={q.error} />
      <Panel title="수집·저장·전달 상태" meta="데이터 없음과 수집 실패를 구분하는 운영 근거">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>영역</th>
                <th>현재 값</th>
                <th>의미 / 다음 행동</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>수집 수락 / 거부</td>
                <td>
                  {number(h?.accepted, 0)} / {number(h?.rejected, 0)}
                </td>
                <td>프로세스 시작 이후. 거부가 증가하면 입력 검증·용량·서버 로그를 확인하세요.</td>
              </tr>
              <tr>
                <td>보존 이벤트 / 용량</td>
                <td>
                  {number(h?.storedEvents, 0)} / {number(h?.capacity, 0)}
                </td>
                <td>{h?.backend} · 용량 초과는 507 응답으로 명시됩니다.</td>
              </tr>
              <tr>
                <td>전달 대기 / 실패</td>
                <td>
                  {number(d?.pending, 0)} / {number(d?.failed, 0)}
                </td>
                <td>
                  {d?.oldestPendingAt
                    ? '가장 오래된 대기: ' + new Date(d.oldestPendingAt).toLocaleString('ko-KR')
                    : '대기 없음'}{' '}
                  · 전체 outbox 집계입니다.
                </td>
              </tr>
              <tr>
                <td>전달 완료</td>
                <td>{number(d?.delivered, 0)}</td>
                <td>
                  HTTP 성공 receipt입니다. 수신 시스템에서 실제 표시·처리는 별도로 확인하세요.
                </td>
              </tr>
              <tr>
                <td>Worker 상태</td>
                <td>
                  {h?.workerError ??
                    (h?.workerHeartbeat
                      ? '최근 실행 ' + time(h.workerHeartbeat)
                      : '실행 기록 없음')}
                </td>
                <td>worker heartbeat 지연과 평가 실패를 함께 확인하세요.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="리전별 Worker" meta="실행 위치와 마지막 heartbeat">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Worker</th>
                <th>실행 리전</th>
                <th>Heartbeat</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {h?.workers.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>{w.region ?? '미지정'}</td>
                  <td>{w.heartbeat ? time(w.heartbeat) : '미기록'}</td>
                  <td>
                    <Badge
                      value={
                        w.error
                          ? 'degraded'
                          : Date.now() - w.lastSeen > 30000
                            ? 'unknown'
                            : 'healthy'
                      }
                    />
                    {w.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!h?.workers.length && (
          <Empty>Live worker 기록이 없습니다. 프로세스 역할과 worker 실행 상태를 확인하세요.</Empty>
        )}
      </Panel>
    </>
  );
}
