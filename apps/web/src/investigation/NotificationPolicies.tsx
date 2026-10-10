import { useState } from 'react';

import type {
  Team,
  NotificationRoute,
  Maintenance,
} from '../../../../packages/contracts/src/index';
import { Panel, Empty, Dialog, number } from '../components';
import { request, queryString } from '../api';
import type { PageProps } from '../Pages';
import { useData, Feedback, Field } from './shared';
export function NotificationPolicies(p: PageProps) {
  const routes = useData<{ items: NotificationRoute[] }>('/api/notification-routes', p),
    maintenance = useData<{ items: Maintenance[] }>('/api/maintenance', p),
    catalog = useData<{ teams: Team[] }>('/api/catalog', p),
    channels = useData<{ channels: { id: string; name: string }[] }>('/api/connections', p);
  const [editing, setEditing] = useState<NotificationRoute | null>(null);
  const [form, setForm] = useState<'route' | 'maintenance' | null>(null),
    [name, setName] = useState(''),
    [service, setService] = useState(''),
    [team, setTeam] = useState(''),
    [environment, setEnvironment] = useState(String(p.params.environment ?? '')),
    [region, setRegion] = useState(String(p.params.region ?? '')),
    [severity, setSeverity] = useState(''),
    [recovery, setRecovery] = useState(true),
    [selected, setSelected] = useState<string[]>([]),
    [repeat, setRepeat] = useState('30'),
    [minutes, setMinutes] = useState('60'),
    [reason, setReason] = useState(''),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <>
      <div className="investigation-intro">
        <div>
          <strong>감지와 전달 정책을 별도로 관리합니다</strong>
          <p>
            등록된 정책이 있으면 매칭되는 목적지만 전달합니다. 일시 중단 중에도 장애 감지는
            유지됩니다.{' '}
            {p.params.workspace === 'demo'
              ? 'Demo 목적지는 미리보기 전용이며 실제 전송되지 않습니다.'
              : ''}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            setForm('maintenance');
            setName('');
          }}
        >
          유지보수 등록
        </button>
        <button
          className="button"
          onClick={() => {
            setEditing(null);
            setService('');
            setTeam('');
            setSelected([]);
            setRepeat('30');
            setForm('route');
            setName('');
          }}
        >
          전달 정책 등록
        </button>
      </div>
      <Feedback error={routes.error ?? maintenance.error} />
      <Panel title="담당자 기반 전달 정책" meta="서비스·담당 팀 조건과 반복·복구 전달">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>정책</th>
                <th>서비스 / 팀</th>
                <th>목적지</th>
                <th>반복 / 복구</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {routes.data?.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => {
                        setEditing(r);
                        setName(r.name);
                        setService(r.service ?? '');
                        setTeam(r.teamId ?? '');
                        setEnvironment(r.environment ?? '');
                        setRegion(r.region ?? '');
                        setSeverity(r.severity ?? '');
                        setRecovery(r.notifyRecovery);
                        setSelected(r.channelIds);
                        setRepeat(String(r.repeatMinutes));
                        setForm('route');
                      }}
                    >
                      {r.name}
                    </button>
                    <small className="cell-detail">
                      {r.environment ?? '전체 환경'} · {r.region ?? '전체 리전'} ·{' '}
                      {r.severity ?? '모든 심각도'} · v{r.revision}
                    </small>
                  </td>
                  <td>
                    {r.service || '전체 서비스'} /{' '}
                    {catalog.data?.teams.find((t) => t.id === r.teamId)?.name ?? '전체 팀'}
                  </td>
                  <td>
                    {r.channelIds
                      .map((id) => channels.data?.channels.find((c) => c.id === id)?.name ?? id)
                      .join(', ')}
                  </td>
                  <td>
                    {r.repeatMinutes}분 / {r.notifyRecovery ? '전달' : '중지'}
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() =>
                        void p.mutate(
                          '/api/notification-routes/' + r.id,
                          { ...r, enabled: !r.enabled },
                          'PATCH',
                        )
                      }
                    >
                      {r.enabled ? '사용 중 · 끄기' : '중지 · 켜기'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!routes.data?.items.length && (
          <Empty>정책이 없으면 기존 방식대로 활성 채널 전체에 전달합니다.</Empty>
        )}
      </Panel>
      <Panel title="유지보수 시간" meta="담당자·기간·사유 기록">
        {maintenance.data?.items.map((m) => (
          <div className="policy-row" key={m.id}>
            <strong>{m.name}</strong>
            <span>
              {m.service || '전체 서비스'} · {new Date(m.from).toLocaleString('ko-KR')} ~{' '}
              {new Date(m.to).toLocaleString('ko-KR')}
            </span>
            <small>
              {m.actor} · {m.reason}
            </small>
            {m.to > Date.now() && (
              <button
                className="text-button"
                onClick={() =>
                  void p.mutate(
                    '/api/maintenance/' + m.id,
                    { ...m, to: Math.max(m.from + 1, Date.now()) },
                    'PATCH',
                  )
                }
              >
                조기 종료
              </button>
            )}
          </div>
        ))}
        {!maintenance.data?.items.length && <Empty>등록된 유지보수 기간이 없습니다.</Empty>}
      </Panel>
      <Panel
        title="전달 대상 미리보기"
        meta="현재 시각의 정책으로 매칭과 억제 이유를 확인 · 실제 전송 없음"
      >
        <select
          aria-label="미리볼 알림"
          defaultValue=""
          onChange={async (e) => {
            if (!e.target.value) return;
            try {
              setPreview(
                await request<Record<string, unknown>>(
                  '/api/notification-routes/preview?' + queryString(p.params),
                  { method: 'POST', body: JSON.stringify({ alertId: e.target.value }) },
                ),
              );
            } catch (err) {
              p.notify((err as Error).message);
            }
          }}
        >
          <option value="">알림 선택</option>
          {p.data.alerts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} / {a.service}
            </option>
          ))}
        </select>
        {preview && (
          <dl className="detail-list">
            <dt>담당 팀</dt>
            <dd>{(preview.team as Team | null)?.name ?? '미지정'}</dd>
            <dt>매칭 정책</dt>
            <dd>
              {(preview.matchedRouteIds as string[])
                .map((id) => routes.data?.items.find((r) => r.id === id)?.name ?? id)
                .join(', ') ||
                (preview.legacyBroadcast ? '기본 전체 전달' : '매칭 없음 · 전달 중지')}
            </dd>
            <dt>전달 목적지</dt>
            <dd>
              {(preview.channelIds as string[])
                .map((id) => channels.data?.channels.find((c) => c.id === id)?.name ?? id)
                .join(', ') || '없음'}
            </dd>
            <dt>유지보수 억제</dt>
            <dd>{(preview.suppressedBy as string[]).length ? '적용됨' : '없음'}</dd>
          </dl>
        )}
      </Panel>
      {form && (
        <Dialog
          title={form === 'route' ? '알림 전달 정책' : '유지보수 등록'}
          onClose={() => setForm(null)}
        >
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              const start = Date.now();
              const result = await p.mutate(
                form === 'route'
                  ? '/api/notification-routes' + (editing ? '/' + editing.id : '')
                  : '/api/maintenance',
                form === 'route'
                  ? {
                      ...(editing ?? {}),
                      name,
                      service: service || undefined,
                      environment: environment || undefined,
                      region: region || undefined,
                      severity: severity || undefined,
                      notifyRecovery: recovery,
                      teamId: team || undefined,
                      channelIds: selected,
                      repeatMinutes: Number(repeat),
                    }
                  : {
                      name,
                      service: service || undefined,
                      environment: environment || undefined,
                      region: region || undefined,
                      from: start,
                      to: start + Number(minutes) * 60000,
                      reason,
                    },
                form === 'route' && editing ? 'PATCH' : 'POST',
              );
              setBusy(false);
              if (result) setForm(null);
            }}
          >
            <Field label="이름">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="대상 서비스 (비우면 전체)">
              <input value={service} onChange={(e) => setService(e.target.value)} />
            </Field>
            <div className="form-grid">
              <Field label="대상 환경 (비우면 전체)">
                <input value={environment} onChange={(e) => setEnvironment(e.target.value)} />
              </Field>
              <Field label="대상 리전 (비우면 전체)">
                <input value={region} onChange={(e) => setRegion(e.target.value)} />
              </Field>
            </div>
            {form === 'route' ? (
              <>
                <Field label="심각도">
                  <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                    <option value="">모든 심각도</option>
                    <option value="warning">주의</option>
                    <option value="critical">심각</option>
                  </select>
                </Field>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={recovery}
                    onChange={(e) => setRecovery(e.target.checked)}
                  />
                  복구 알림 전달
                </label>
                <Field label="담당 팀">
                  <select value={team} onChange={(e) => setTeam(e.target.value)}>
                    <option value="">전체 팀</option>
                    {catalog.data?.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <fieldset>
                  <legend>알림 목적지</legend>
                  {channels.data?.channels.map((c) => (
                    <label className="checkbox" key={c.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(c.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, c.id]
                              : selected.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                  {!channels.data?.channels.length && (
                    <p>연결 및 설정에서 Live 알림 목적지를 먼저 등록하세요.</p>
                  )}
                </fieldset>
                <Field label="미확인 알림 반복 (분)">
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="기간 (현재 시각부터, 분)">
                  <input
                    type="number"
                    min="1"
                    max="10080"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </Field>
                <Field label="중단 사유">
                  <textarea required value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </>
            )}
            <button className="button" disabled={busy || (form === 'route' && !selected.length)}>
              저장
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
