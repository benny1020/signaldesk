import { useState } from 'react';

import { Plus, ShieldCheck } from 'lucide-react';
import type { SLOResult, SLO } from '../../../../packages/contracts/src/index';
import { Panel, Empty, Dialog, Badge, number } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback, Field } from './shared';
export function ServiceLevels(p: PageProps) {
  const q = useData<{ items: SLOResult[] }>('/api/slos/status', p);
  const definitions = useData<{ items: SLO[] }>('/api/slos', p);
  const [editing, setEditing] = useState<SLO | null>(null);
  const [minimum, setMinimum] = useState('10'),
    [burn, setBurn] = useState('2'),
    [route, setRoute] = useState('');
  const [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [service, setService] = useState(String(p.params.service ?? p.data.services[0]?.name ?? '')),
    [objective, setObjective] = useState('99.9'),
    [indicator, setIndicator] = useState('availability'),
    [latency, setLatency] = useState('1000'),
    [window, setWindow] = useState('60'),
    [busy, setBusy] = useState(false);
  function edit(d?: SLO) {
    setEditing(d ?? null);
    setName(d?.name ?? '');
    setService(d?.service ?? String(p.params.service ?? p.data.services[0]?.name ?? ''));
    setObjective(String(d?.objective ?? 99.9));
    setIndicator(d?.indicator ?? 'availability');
    setLatency(String(d?.latencyMs ?? 1000));
    setWindow(String(d?.windowMinutes ?? 60));
    setMinimum(String(d?.minimumRequests ?? 10));
    setBurn(String(d?.alertBurnRate ?? 2));
    setRoute(d?.route ?? '');
    setOpen(true);
  }
  return (
    <>
      <div className="investigation-intro">
        <ShieldCheck size={22} />
        <div>
          <strong>차트와 경보가 같은 서비스 기준을 사용합니다</strong>
          <p>
            실제 관측 server/root span의 분모를 사용합니다. 표본 수집률과 전체 요청 수는 별도로
            검증하세요.
          </p>
        </div>
        <button className="button" disabled={!p.canWrite} onClick={() => edit()}>
          <Plus size={15} />
          SLO 정의
        </button>
      </div>
      <Feedback error={q.error} />
      <Panel title="서비스 수준과 오류 예산" meta="선택한 종료 시각 기준의 정의별 평가 기간">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>목표</th>
                <th>서비스 / 범위</th>
                <th className="numeric">성공률 / 목표</th>
                <th className="numeric">관측 요청</th>
                <th className="numeric">예산 잔여</th>
                <th className="numeric">Burn rate</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((r) => (
                <tr key={r.definition.id}>
                  <td>
                    <button
                      className="text-button"
                      disabled={!p.canWrite}
                      onClick={() => edit(r.definition)}
                    >
                      {r.definition.name}
                    </button>
                    <small className="cell-detail">
                      {r.definition.indicator === 'latency'
                        ? `${r.definition.latencyMs} ms 이내`
                        : '성공 응답'}{' '}
                      · v{r.definition.revision}
                    </small>
                  </td>
                  <td>
                    {r.definition.service}
                    <small className="cell-detail">
                      {r.definition.region ?? '전체 리전'} · {r.definition.windowMinutes}분
                    </small>
                  </td>
                  <td className="numeric">
                    {number(r.successPct, 3)}% / {r.definition.objective}%
                  </td>
                  <td className="numeric">{number(r.total, 0)}</td>
                  <td className="numeric">{number(r.budgetRemainingPct, 1)}%</td>
                  <td className="numeric">{number(r.burnRate, 2)}×</td>
                  <td>
                    <Badge
                      label={r.status === 'insufficient' ? '관측 부족' : undefined}
                      value={
                        r.status === 'violated'
                          ? 'degraded'
                          : r.status === 'insufficient'
                            ? 'unknown'
                            : 'healthy'
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!q.data?.items.length && <Empty>성공률 또는 지연 목표를 정의하세요.</Empty>}
      </Panel>
      {!!definitions.data?.items.filter((d) => !d.enabled).length && (
        <Panel title="중지된 목표" meta="같은 ID와 이력을 유지하고 다시 사용">
          {definitions.data.items
            .filter((d) => !d.enabled)
            .map((d) => (
              <div className="policy-row" key={d.id}>
                <strong>{d.name}</strong>
                <span>
                  {d.service} · v{d.revision}
                </span>
                <button className="text-button" disabled={!p.canWrite} onClick={() => edit(d)}>
                  편집 / 다시 켜기
                </button>
              </div>
            ))}
        </Panel>
      )}
      {open && (
        <Dialog title="서비스 수준 목표" onClose={() => setOpen(false)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const result = await p.mutate(
                '/api/slos' + (editing ? '/' + editing.id : ''),
                {
                  ...(editing ?? {}),
                  name,
                  service,
                  environment: editing?.environment ?? p.params.environment ?? 'production',
                  region: editing?.region ?? p.params.region,
                  objective: Number(objective),
                  indicator,
                  latencyMs: Number(latency),
                  windowMinutes: Number(window),
                  minimumRequests: Number(minimum),
                  alertBurnRate: Number(burn),
                  route: route || undefined,
                  enabled: true,
                },
                editing ? 'PATCH' : 'POST',
              );
              setBusy(false);
              if (result) setOpen(false);
            }}
          >
            <Field label="목표 이름">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="서비스">
              <input required value={service} onChange={(e) => setService(e.target.value)} />
            </Field>
            <Field label="측정 기준">
              <select value={indicator} onChange={(e) => setIndicator(e.target.value)}>
                <option value="availability">요청 성공률</option>
                <option value="latency">지연 목표 이내 비율</option>
              </select>
            </Field>
            <Field label="목표 성공 비율 (%)">
              <input
                type="number"
                min="90"
                max="99.9999"
                step="0.0001"
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
              />
            </Field>
            {indicator === 'latency' && (
              <Field label="응답 시간 기준 (ms)">
                <input
                  type="number"
                  min="1"
                  value={latency}
                  onChange={(e) => setLatency(e.target.value)}
                />
              </Field>
            )}
            <Field label="평가 기간 (분)">
              <input
                type="number"
                min="5"
                max="10080"
                value={window}
                onChange={(e) => setWindow(e.target.value)}
              />
            </Field>
            <p className="muted">
              {editing
                ? '기존 정의의 환경과 리소스 범위를 유지합니다.'
                : '현재 선택한 환경과 리전이 적용됩니다.'}{' '}
              관측 요청이 부족하면 건강 상태를 알 수 없습니다.
            </p>
            <Field label="API 경로 (비우면 서비스 전체)">
              <input
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                placeholder="/orders/:id"
              />
            </Field>
            <div className="form-grid">
              <Field label="최소 관측 요청">
                <input
                  type="number"
                  min="1"
                  max="1000000"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                />
              </Field>
              <Field label="경보 Burn rate">
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  max="10000"
                  value={burn}
                  onChange={(e) => setBurn(e.target.value)}
                />
              </Field>
            </div>
            {editing?.enabled && (
              <button
                type="button"
                className="button secondary"
                disabled={!p.canWrite || busy}
                onClick={async () => {
                  setBusy(true);
                  const ok = await p.mutate(
                    '/api/slos/' + editing.id,
                    { ...editing, enabled: false },
                    'PATCH',
                  );
                  setBusy(false);
                  if (ok) setOpen(false);
                }}
              >
                목표 중지 · 활성 경보 해결
              </button>
            )}
            <button className="button" disabled={!p.canWrite || busy}>
              정의 저장
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
