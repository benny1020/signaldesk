import { useState, useRef, type FormEvent } from 'react';
import type { Alert, Dashboard, RuleInput } from '../../../packages/contracts/src/index';
import { metricNames, dimensionKeys } from '../../../packages/contracts/src/index';
import { Dialog, number } from './components';
import { request, queryString } from './api';
export function CreateForm({
  kind,
  alert,
  data,
  params,
  onClose,
  onCreated,
}: {
  kind: 'rule' | 'incident' | 'channel' | 'probe';
  alert?: Alert;
  data: Dashboard;
  params: Record<string, string | number | undefined>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const form = useRef<HTMLFormElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<{
      latest: number | null;
      samples: number;
      violations: number;
      groupCount: number;
      noDataGroups: number;
    } | null>(null);
  const title = {
    rule: '알림 규칙 만들기',
    incident: '장애 등록',
    channel: '알림 채널 연결',
    probe: 'API 검사 추가',
  }[kind];
  const values = () => {
    const f = new FormData(form.current!);
    return Object.fromEntries([...f].map(([k, v]) => [k, String(v)]));
  };
  function ruleValues(): RuleInput {
    const v = values();
    return {
      name: v.name,
      service: v.service,
      environment: v.environment,
      ...Object.fromEntries(dimensionKeys.map((key) => [key, v[key] || undefined])),
      groupBy: v.groupBy as RuleInput['groupBy'],
      metric: v.metric as RuleInput['metric'],
      operator: v.operator as 'gt' | 'lt',
      threshold: Number(v.threshold),
      durationSec: Number(v.durationSec),
      severity: v.severity as 'critical' | 'warning',
      noData: v.noData as 'ignore' | 'alert',
      enabled: true,
    };
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body =
        kind === 'rule'
          ? ruleValues()
          : kind === 'incident'
            ? {
                ...values(),
                ...Object.fromEntries(
                  dimensionKeys.map((key) => [key, values()[key] || undefined]),
                ),
                ...(alert ? { alertId: alert.id } : {}),
              }
            : {
                ...values(),
                ...(kind === 'probe' ? { vantageRegion: values().vantageRegion || undefined } : {}),
                ...Object.fromEntries(
                  dimensionKeys.map((key) => [key, values()[key] || undefined]),
                ),
              };
      await request(
        '/api/' +
          { rule: 'rules', incident: 'incidents', channel: 'channels', probe: 'probes' }[kind] +
          '?' +
          queryString({ workspace: params.workspace }),
        { method: 'POST', body: JSON.stringify(body) },
      );
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    if (!form.current?.reportValidity()) return;
    setBusy(true);
    setError('');
    try {
      setPreview(
        await request('/api/rules/preview?' + queryString(params), {
          method: 'POST',
          body: JSON.stringify(ruleValues()),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form ref={form} onSubmit={submit} className="form">
        <label>
          {kind === 'incident' ? '장애 제목' : '이름'}
          <input
            required
            name={kind === 'incident' ? 'title' : 'name'}
            maxLength={160}
            placeholder={
              kind === 'rule'
                ? '예: Checkout 오류율 상승'
                : kind === 'incident'
                  ? '예: 결제 API 응답 지연'
                  : '이름을 입력하세요'
            }
            defaultValue={alert?.title ?? ''}
          />
        </label>
        {(kind === 'rule' || kind === 'incident' || kind === 'probe') && (
          <div className="form-grid">
            <label>
              서비스
              <input
                name="service"
                list="service-options"
                required
                defaultValue={alert?.service ?? String(params.service ?? '')}
                placeholder="orders-api"
              />
              <datalist id="service-options">
                {data.services.map((s) => (
                  <option key={s.name + s.environment} value={s.name} />
                ))}
              </datalist>
            </label>
            <label>
              환경
              <input
                required
                name="environment"
                defaultValue={alert?.environment ?? String(params.environment ?? 'production')}
              />
            </label>
          </div>
        )}
        {(kind === 'rule' || kind === 'incident' || kind === 'probe') && (
          <>
            <div className="form-grid">
              {[
                ['region', '리전'],
                ['module', '모듈'],
                ['cluster', '클러스터'],
                ['namespace', '네임스페이스'],
                ['zone', '가용 영역'],
                ['instanceId', '인스턴스'],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    name={key}
                    maxLength={128}
                    defaultValue={String(alert?.[key as keyof Alert] ?? params[key] ?? '')}
                    placeholder={
                      kind === 'rule' || kind === 'incident'
                        ? '미입력 시 전체 범위'
                        : '검사 대상의 위치'
                    }
                  />
                </label>
              ))}
            </div>
            {kind === 'rule' && (
              <label>
                알림 평가 단위
                <select name="groupBy" defaultValue="resource">
                  <option value="resource">인스턴스별 — 각각 발생·복구</option>
                  <option value="region">리전별 — 선택한 인스턴스 합산</option>
                  <option value="service">서비스별 — 선택한 전체 범위 합산</option>
                </select>
                <small>
                  인스턴스별 평가가 기본입니다. p95·CPU·메모리 합산 평가는 최대값, 요청량은 합계,
                  오류율은 요청 가중값을 사용합니다.
                </small>
              </label>
            )}
          </>
        )}
        {kind === 'rule' && (
          <>
            <div className="form-grid">
              <label>
                측정 지표
                <select name="metric">
                  {metricNames.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                비교
                <select name="operator">
                  <option value="gt">보다 큼 (&gt;)</option>
                  <option value="lt">보다 작음 (&lt;)</option>
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label>
                임계치
                <input required name="threshold" type="number" step="any" defaultValue={2} />
              </label>
              <label>
                지속 시간 (초)
                <input
                  required
                  name="durationSec"
                  type="number"
                  min={0}
                  max={86400}
                  defaultValue={60}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                심각도
                <select name="severity">
                  <option value="warning">주의</option>
                  <option value="critical">심각</option>
                </select>
              </label>
              <label>
                최근 데이터 없음
                <select name="noData">
                  <option value="alert">알림 발생</option>
                  <option value="ignore">무시</option>
                </select>
              </label>
            </div>
            <div className="form-hint">
              규칙은 지정한 서비스와 환경의 최근 측정값을 평가합니다. 최근 2분간 측정값이 없으면
              데이터 없음 정책을 적용합니다.
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void inspect()}
            >
              현재 데이터로 미리보기
            </button>
            {preview && (
              <div className="preview">
                최대 평가 값 {preview.latest === null ? '없음' : number(preview.latest, 3)} · 표본{' '}
                {preview.samples}개 · 현재 평가 {preview.groupCount}개 그룹 · 초과{' '}
                {preview.violations}개 · 데이터 없음 {preview.noDataGroups}개<br />
                <small>단일 표본 비교입니다. 지속 시간 충족 여부는 작업 실행 중 평가합니다.</small>
              </div>
            )}
          </>
        )}
        {kind === 'incident' && (
          <div className="form-grid">
            <label>
              담당자
              <input name="owner" maxLength={100} placeholder="담당자 또는 팀" />
            </label>
            <label>
              심각도
              <select name="severity" defaultValue={alert?.severity ?? 'warning'}>
                <option value="warning">주의</option>
                <option value="critical">심각</option>
              </select>
            </label>
          </div>
        )}
        {kind === 'probe' && (
          <label>
            검사 실행 리전 (비우면 가용 worker)
            <input name="vantageRegion" placeholder="ap-northeast-2" />
            <small>지정 리전의 worker가 없으면 검사가 실행되지 않습니다.</small>
          </label>
        )}
        {(kind === 'channel' || kind === 'probe') && (
          <>
            <label>
              {kind === 'channel' ? 'HTTPS Webhook 주소' : '검사할 HTTPS 주소'}
              <input required name="url" type="url" placeholder="https://" maxLength={2000} />
            </label>
            <div className="form-hint">
              {kind === 'channel'
                ? '등록 후 새 알림이 발생하면 이 주소로 전달됩니다. 주소는 암호화해 저장하고 API 응답에는 포함하지 않습니다.'
                : '등록 후 60초 간격으로 GET 요청을 보냅니다. 2xx 응답을 정상으로 판단합니다.'}{' '}
              사설 주소는 운영자의 허용 설정이 필요합니다.
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="error-message">
            {error}
          </div>
        )}
        <footer className="form-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            취소
          </button>
          <button disabled={busy} className="button">
            {busy
              ? '저장 중…'
              : kind === 'rule'
                ? '규칙 저장'
                : kind === 'incident'
                  ? '장애 등록'
                  : '연결 저장'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
