import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  RequestFlow,
  FlowEdge,
  DependencyMonitor,
  DependencyStatus,
} from '../../../../packages/contracts/src/index';
import type { PageProps } from '../Pages';
import { Dialog, number } from '../components';
import { request } from '../api';
export function DependencyRules({
  p,
  data,
  selected,
}: {
  p: PageProps;
  data: RequestFlow;
  selected?: FlowEdge;
}) {
  const query = useQuery({
    queryKey: ['dependency-monitors', p.params.workspace],
    queryFn: () =>
      request<{ items: DependencyMonitor[]; statuses: DependencyStatus[]; observedAt: number }>(
        '/api/dependency-monitors?workspace=' + p.params.workspace,
      ),
    refetchInterval: p.paused ? false : 10000,
  });
  const state = (m: DependencyMonitor) => {
    const s = query.data?.statuses.find((x) => x.id === m.id);
    return !m.enabled
      ? '중지됨'
      : !s || s.revision !== m.revision
        ? '평가 대기'
        : (query.data?.observedAt ?? Date.now()) - s.at > 30000
          ? '평가 지연'
          : s.status === 'violated'
            ? '기준 초과'
            : s.status === 'healthy'
              ? '관측 정상'
              : '근거 부족';
  };
  const [editing, setEditing] = useState<Partial<DependencyMonitor> | null>(null),
    [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    const { id, ...body } = editing;
    const result = await p.mutate(
      '/api/dependency-monitors' + (id ? '/' + id : ''),
      body,
      id ? 'PATCH' : 'POST',
    );
    setBusy(false);
    if (result) setEditing(null);
  };
  const create = () => {
    if (!selected) return;
    const source = data.nodes.find((n) => n.id === selected.source)!,
      target = data.nodes.find((n) => n.id === selected.target)!;
    setEditing({
      name: `${source.name} → ${target.name}`,
      service: source.name,
      environment: source.environment,
      ...(source.region !== 'unknown' ? { region: source.region } : {}),
      ...(source.module !== 'unknown' ? { module: source.module } : {}),
      dependency: target.name,
      route: selected.route,
      method: selected.method,
      indicator: 'error_pct',
      threshold: 5,
      minimumRequests: 20,
      windowMinutes: 5,
      enabled: true,
    });
  };
  return (
    <section className="flow-rules">
      <div className="flow-section-head">
        <div>
          <h2>하위 호출 관측 규칙</h2>
          <p>현재 설정 · 표본이 부족하면 상태를 확정하지 않습니다. Live worker가 평가합니다.</p>
        </div>
        <button
          className="button secondary"
          disabled={selected?.direction !== 'outbound'}
          onClick={create}
        >
          선택한 하위 호출에 규칙 추가
        </button>
      </div>
      {query.error && <p role="alert">{query.error.message}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>서비스 / 대상</th>
              <th>route / 범위</th>
              <th>관측 기준</th>
              <th>평가 상태</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.service} → {m.dependency}
                </td>
                <td>
                  {m.method} {m.route}
                  <small>
                    {m.environment} / {m.region ?? '모든 리전'} / {m.module ?? '모든 모듈'}
                  </small>
                </td>
                <td>
                  {m.indicator === 'error_pct' ? '실패율' : '관측 p95'} &gt; {number(m.threshold)}
                  {m.indicator === 'error_pct' ? '%' : 'ms'}
                  <small>
                    {m.windowMinutes}분 / 최소 {m.minimumRequests}건
                  </small>
                </td>
                <td>{state(m)}</td>
                <td>
                  <button className="text-button" onClick={() => setEditing(m)}>
                    편집
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      void p.mutate(
                        '/api/dependency-monitors/' + m.id,
                        { ...m, enabled: !m.enabled },
                        'PATCH',
                      )
                    }
                  >
                    {m.enabled ? '중지' : '재개'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.data && !query.data.items.length && (
          <div className="empty">연결을 선택하고 관측 실패율 또는 지연 규칙을 등록하세요.</div>
        )}
      </div>
      {editing && (
        <Dialog title="하위 호출 관측 규칙" onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="control-form"
          >
            <p className="flow-rule-scope">
              {editing.service} → {editing.dependency}
              <br />
              {editing.method} {editing.route}
              <br />
              {editing.environment} / {editing.region ?? '모든 리전'} /{' '}
              {editing.module ?? '모든 모듈'}
            </p>
            <label>
              규칙 이름
              <input
                required
                maxLength={160}
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label>
              관측 지표
              <select
                value={editing.indicator}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    indicator: e.target.value as DependencyMonitor['indicator'],
                    threshold: e.target.value === 'p95_ms' ? 1000 : 5,
                  })
                }
              >
                <option value="error_pct">하위 호출 실패율 (%)</option>
                <option value="p95_ms">관측 p95 지연 (ms)</option>
              </select>
            </label>
            <label>
              초과 임계치
              <input
                required
                type="number"
                min="0.01"
                step="any"
                max={editing.indicator === 'error_pct' ? 100 : 86400000}
                value={editing.threshold}
                onChange={(e) => setEditing({ ...editing, threshold: Number(e.target.value) })}
              />
            </label>
            <div className="form-grid">
              <label>
                평가 시간창 (분)
                <input
                  required
                  type="number"
                  min="1"
                  max="1440"
                  value={editing.windowMinutes}
                  onChange={(e) =>
                    setEditing({ ...editing, windowMinutes: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                최소 관측 호출 수
                <input
                  required
                  type="number"
                  min="1"
                  max="1000000"
                  value={editing.minimumRequests}
                  onChange={(e) =>
                    setEditing({ ...editing, minimumRequests: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <p className="muted">
              리전·모듈·route별로 평가합니다. 알림은 기존 전달 정책·유지보수·확인·반복·복구 흐름을
              따릅니다. 고객 요청 전체의 SLO가 아닙니다.
            </p>
            <button className="button" disabled={busy}>
              {busy ? '저장 중…' : '규칙 저장'}
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
