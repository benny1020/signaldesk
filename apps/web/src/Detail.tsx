import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Copy, FileText } from 'lucide-react';
import type { Dashboard, Span, Incident } from '../../../packages/contracts/src/index';
import type { Selection, PageProps } from './Pages';
import {
  Dialog,
  Panel,
  Badge,
  time,
  number,
  TraceWaterfall,
  Chart,
  ChartBoundary,
  Empty,
} from './components';
import { request, queryString } from './api';
type Briefing = {
  mode: string;
  headline: string;
  facts: { text: string; source: { kind: string; id: string; traceId?: string } }[];
  hypotheses: string[];
  limitations: string;
  truncated: boolean;
};
export function Detail({
  selection,
  onClose,
  ...p
}: PageProps & { selection: Selection; onClose: () => void }) {
  const [note, setNote] = useState(''),
    [owner, setOwner] = useState(''),
    [busy, setBusy] = useState(false);
  const trace = useQuery({
    queryKey: ['trace', selection.type === 'trace' ? selection.id : '', p.params],
    enabled: selection.type === 'trace',
    queryFn: () =>
      request<{ items: Span[]; truncated: boolean }>(
        '/api/traces/' +
          encodeURIComponent(selection.type === 'trace' ? selection.id : '') +
          '?' +
          queryString(p.params),
      ),
  });
  const service = useQuery({
    queryKey: ['service', selection.type === 'service' ? selection.name : '', p.params],
    enabled: selection.type === 'service',
    queryFn: () =>
      request<Dashboard>(
        '/api/dashboard?' +
          queryString({ ...p.params, service: selection.type === 'service' ? selection.name : '' }),
      ),
  });
  const briefParams = {
    ...p.params,
    ...(selection.type === 'briefing'
      ? {
          service: selection.service ?? p.params.service,
          environment: selection.environment ?? p.params.environment,
          ...Object.fromEntries(
            ['module', 'region', 'zone', 'cluster', 'namespace', 'instanceId'].map((key) => [
              key,
              selection[key as keyof typeof selection] ?? p.params[key],
            ]),
          ),
        }
      : {}),
  };
  const brief = useQuery({
    queryKey: ['briefing', briefParams],
    enabled: selection.type === 'briefing',
    queryFn: () => request<Briefing>('/api/briefing?' + queryString(briefParams)),
  });
  const incident =
    selection.type === 'incident'
      ? (p.data.incidents.find((i) => i.id === selection.incident.id) ?? selection.incident)
      : null;
  async function changeIncident(body: unknown) {
    if (!incident) return;
    setBusy(true);
    try {
      const result = await p.mutate('/api/incidents/' + incident.id, body, 'PATCH');
      if (result) setNote('');
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      p.notify('클립보드에 복사했습니다.');
    } catch {
      p.notify('복사 권한을 확인하세요.');
    }
  }
  const title =
    selection.type === 'service'
      ? selection.name
      : selection.type === 'trace'
        ? '요청 트레이스'
        : selection.type === 'log'
          ? '로그 근거'
          : selection.type === 'incident'
            ? '장애 타임라인'
            : '운영 근거 브리핑';
  return (
    <Dialog title={title} drawer onClose={onClose}>
      {selection.type === 'log' ? (
        <>
          <div className="detail-meta">
            <span className={'event-level ' + selection.log.level}>{selection.log.level}</span>
            <span>{selection.log.service}</span>
            <time>{time(selection.log.timestamp)}</time>
          </div>
          <pre className="log-message">{selection.log.message}</pre>
          <dl className="detail-list">
            <dt>환경</dt>
            <dd>{selection.log.environment}</dd>
            {Object.entries({
              모듈: selection.log.module,
              리전: selection.log.region,
              클러스터: selection.log.cluster,
              네임스페이스: selection.log.namespace,
              인스턴스: selection.log.instanceId,
            }).map(([label, value]) => (
              <div className="detail-pair" key={label}>
                <dt>{label}</dt>
                <dd>{value ?? '미지정'}</dd>
              </div>
            ))}
            <dt>로그 ID</dt>
            <dd className="mono">{selection.log.id}</dd>
            {Object.entries(selection.log.attributes).map(([k, v]) => (
              <div className="detail-pair" key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
          <div className="row-actions">
            <button
              className="button secondary"
              onClick={() => void copy(JSON.stringify(selection.log, null, 2))}
            >
              <Copy size={14} /> 로그 복사
            </button>
            {selection.log.traceId && (
              <button
                className="button"
                onClick={() => p.select({ type: 'trace', id: selection.log.traceId! })}
              >
                트레이스 열기 <ArrowUpRight size={14} />
              </button>
            )}
          </div>
        </>
      ) : selection.type === 'trace' ? (
        <>
          {trace.isPending ? (
            <Empty>트레이스를 불러오고 있습니다…</Empty>
          ) : trace.isError ? (
            <Empty>{trace.error.message}</Empty>
          ) : (
            <>
              <div className="trace-summary">
                <span className="mono">{selection.id}</span>
                <button
                  className="icon-button"
                  aria-label="Trace ID 복사"
                  onClick={() => void copy(selection.id)}
                >
                  <Copy size={15} />
                </button>
                <span>
                  {trace.data.items.length}개 스팬 ·{' '}
                  {new Set(trace.data.items.map((s) => s.region ?? 'unknown')).size}개 리전
                </span>
              </div>
              {trace.data.truncated && (
                <div className="notice">일부 스팬만 표시됩니다. 시간 범위를 좁히세요.</div>
              )}
              <p className="muted">
                트레이스는 현재 환경·시간 내 요청에 연결된 서비스와 모듈의 스팬을 함께 표시합니다.
              </p>
              <TraceWaterfall
                spans={trace.data.items}
                onService={(s) =>
                  p.focusResource(
                    {
                      ...s,
                      id: s.id ?? s.spanId,
                      firstSeen: s.timestamp,
                      lastSeen: s.timestamp,
                      retired: false,
                      requestRate: null,
                      errorPct: null,
                      latency: null,
                      status: 'unknown',
                      module: s.module ?? 'unknown',
                      region: s.region ?? 'unknown',
                      zone: s.zone ?? 'unknown',
                      cluster: s.cluster ?? 'unknown',
                      namespace: s.namespace ?? 'unknown',
                      instanceId: s.instanceId ?? 'unknown',
                    },
                    'services',
                  )
                }
              />
              {trace.data.items
                .filter((s) => s.ai)
                .map((s) => (
                  <Panel title="AI 호출 근거" key={s.spanId}>
                    <dl className="detail-list">
                      <dt>모델</dt>
                      <dd>
                        {s.ai!.provider} / {s.ai!.model}
                      </dd>
                      <dt>토큰 입력 / 출력</dt>
                      <dd>
                        {s.ai!.inputTokens} / {s.ai!.outputTokens}
                      </dd>
                      <dt>보고 비용</dt>
                      <dd>
                        {s.ai!.costUsd === undefined ? '미제공' : '$' + number(s.ai!.costUsd, 5)}
                      </dd>
                      <dt>비용 출처</dt>
                      <dd>{s.ai!.costSource ?? '미제공'}</dd>
                      <dt>첫 토큰 지연</dt>
                      <dd>{s.ai!.ttftMs === undefined ? '미제공' : s.ai!.ttftMs + ' ms'}</dd>
                    </dl>
                  </Panel>
                ))}
              <Panel title="스팬 속성">
                <div className="span-attributes">
                  {trace.data.items.map((s) => (
                    <details key={s.spanId}>
                      <summary>
                        {s.name} <Badge value={s.status} />
                      </summary>
                      <p className="muted">
                        {s.service} · {s.module ?? '미지정'} · {s.region ?? '미지정'} ·{' '}
                        {s.instanceId ?? '미지정'}
                      </p>
                      <pre>{JSON.stringify(s.attributes, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              </Panel>
            </>
          )}
        </>
      ) : selection.type === 'service' ? (
        <>
          {service.isPending ? (
            <Empty>서비스 데이터를 불러오고 있습니다…</Empty>
          ) : service.isError ? (
            <Empty>{service.error.message}</Empty>
          ) : (
            <>
              <div className="detail-meta">
                {service.data.services[0] && <Badge value={service.data.services[0].status} />}
                <span>{service.data.services[0]?.environment ?? '수집 데이터 없음'}</span>
              </div>
              <ChartBoundary>
                <Chart title="서비스 요청량" series={[service.data.series.request_rate]} />
                <Chart title="서비스 p95 응답" series={[service.data.series.latency_p95_ms]} />
              </ChartBoundary>
              <div className="row-actions">
                <button
                  className="button"
                  onClick={() => {
                    p.navigate('logs', selection.name);
                    onClose();
                  }}
                >
                  관련 로그
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    p.navigate('traces', selection.name);
                    onClose();
                  }}
                >
                  관련 트레이스
                </button>
              </div>
              <Panel title="최근 오류 근거">
                <div className="event-list">
                  {service.data.logs
                    .filter((l) => l.level === 'error')
                    .slice(0, 5)
                    .map((l) => (
                      <button key={l.id} onClick={() => p.select({ type: 'log', log: l })}>
                        <span className="event-level error">error</span>
                        <div>
                          <strong>{l.message}</strong>
                          <small>{time(l.timestamp)}</small>
                        </div>
                      </button>
                    ))}
                  {!service.data.logs.some((l) => l.level === 'error') && (
                    <Empty>선택한 범위에 오류 로그가 없습니다.</Empty>
                  )}
                </div>
              </Panel>
            </>
          )}
        </>
      ) : selection.type === 'incident' && incident ? (
        <>
          <div className="detail-meta">
            <Badge value={incident.status} />
            <Badge value={incident.severity} />
          </div>
          <h3 className="incident-title">{incident.title}</h3>
          <p className="muted">
            {incident.service} · {incident.environment} · {incident.region ?? '전체 리전'} ·{' '}
            {incident.instanceId ?? '그룹'} · {incident.owner || '담당 미지정'}
          </p>
          <div className="form-grid incident-controls">
            <label>
              장애 상태
              <select
                aria-label="장애 상태"
                value={incident.status}
                disabled={!p.canWrite || busy}
                onChange={(e) => void changeIncident({ status: e.target.value })}
              >
                {['investigating', 'identified', 'monitoring', 'resolved'].map((s) => (
                  <option key={s} value={s}>
                    {
                      {
                        investigating: '조사 중',
                        identified: '원인 확인',
                        monitoring: '복구 관찰',
                        resolved: '해결됨',
                      }[s]
                    }
                  </option>
                ))}
              </select>
            </label>
            <label>
              담당자
              <div className="input-action">
                <input
                  aria-label="담당자 변경"
                  placeholder={incident.owner || '담당자 또는 팀'}
                  value={owner}
                  readOnly={!p.canWrite}
                  onChange={(e) => setOwner(e.target.value)}
                />
                <button
                  className="button secondary"
                  disabled={!p.canWrite || busy}
                  onClick={() => void changeIncident({ owner })}
                >
                  저장
                </button>
              </div>
            </label>
          </div>
          <Panel title="연결된 알림" meta="같은 장애에 여러 감지 근거 연결">
            {p.data.alerts
              .filter(
                (a) =>
                  a.service === incident.service ||
                  (incident.alertIds ?? []).includes(a.id) ||
                  incident.alertId === a.id,
              )
              .map((a) => {
                const ids = incident.alertIds ?? (incident.alertId ? [incident.alertId] : []);
                return (
                  <label className="checkbox" key={a.id}>
                    <input
                      type="checkbox"
                      disabled={!p.canWrite || busy}
                      checked={ids.includes(a.id)}
                      onChange={(e) =>
                        void changeIncident({
                          alertIds: e.target.checked
                            ? [...ids, a.id]
                            : ids.filter((id) => id !== a.id),
                        })
                      }
                    />
                    {a.title} · {a.region ?? '전체 리전'} · {a.status}
                  </label>
                );
              })}
          </Panel>
          <div className="timeline">
            {incident.timeline.map((t) => (
              <div key={t.id}>
                <span className="timeline-dot" />
                <time>{time(t.time)}</time>
                <strong>{t.text}</strong>
                <small>{t.actor}</small>
              </div>
            ))}
          </div>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void changeIncident({ note });
            }}
          >
            <label>
              조사 메모
              <textarea
                required
                maxLength={2000}
                rows={3}
                value={note}
                disabled={!p.canWrite}
                onChange={(e) => setNote(e.target.value)}
                placeholder="확인한 근거와 다음 조치를 기록하세요."
              />
            </label>
            <button className="button" disabled={!p.canWrite || busy || !note.trim()}>
              타임라인에 기록
            </button>
          </form>
          <button
            className="button secondary briefing-action"
            onClick={() =>
              p.select({
                type: 'briefing',
                service: incident.service,
                environment: incident.environment,
                module: incident.module,
                region: incident.region,
                zone: incident.zone,
                cluster: incident.cluster,
                namespace: incident.namespace,
                instanceId: incident.instanceId,
              })
            }
          >
            <FileText size={15} /> 근거 브리핑
          </button>
        </>
      ) : (
        <>
          {brief.isPending ? (
            <Empty>근거를 모으고 있습니다…</Empty>
          ) : brief.isError ? (
            <Empty>{brief.error.message}</Empty>
          ) : (
            <>
              <div className="briefing-label">로컬 규칙 기반 · 외부 모델 호출 없음</div>
              <h3>{brief.data.headline}</h3>
              <div className="briefing-facts">
                {brief.data.facts.map((f, i) => (
                  <article key={i}>
                    <p>{f.text}</p>
                    {(f.source.kind === 'trace' || f.source.traceId) && (
                      <button
                        className="text-button"
                        onClick={() =>
                          p.select({ type: 'trace', id: f.source.traceId ?? f.source.id })
                        }
                      >
                        출처 트레이스 <ArrowUpRight size={13} />
                      </button>
                    )}
                    {f.source.kind === 'alert' && (
                      <button
                        className="text-button"
                        onClick={() => {
                          p.navigate('alerts');
                          onClose();
                        }}
                      >
                        출처 알림 보기
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {brief.data.hypotheses.length > 0 && (
                <Panel title="확인이 필요한 가설">
                  {brief.data.hypotheses.map((h) => (
                    <p className="panel-copy" key={h}>
                      {h}
                    </p>
                  ))}
                </Panel>
              )}
              <div className="notice">{brief.data.limitations}</div>
              {brief.data.truncated && (
                <div className="notice">
                  범위 내 모든 데이터가 분석된 것은 아닙니다. 조회 상한을 확인하세요.
                </div>
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
