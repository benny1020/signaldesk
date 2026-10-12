import { useState } from 'react';

import type {
  AggregateResult,
  EvaluationDataset,
  EvaluationRun,
} from '../../../../packages/contracts/src/index';
import { Panel, Empty, Dialog, number } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback, Field } from './shared';
export function AIOperations(p: PageProps) {
  const models = useData<AggregateResult>('/api/analysis/ai', p),
    datasets = useData<{ items: EvaluationDataset[] }>('/api/evaluation/datasets', p),
    runs = useData<{ items: EvaluationRun[] }>('/api/evaluation/runs', p);
  const [form, setForm] = useState<'dataset' | 'run' | null>(null),
    [name, setName] = useState(''),
    [version, setVersion] = useState('v1'),
    [cases, setCases] = useState(
      '[\n  {"id":"case-1","expected":{"answer_correct":true},"actual":{"answer_correct":true}}\n]',
    ),
    [datasetId, setDatasetId] = useState(''),
    [modelVersion, setModelVersion] = useState(''),
    [promptVersion, setPromptVersion] = useState(''),
    [baselineId, setBaselineId] = useState(''),
    [actuals, setActuals] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <>
      <Panel title="AI 버전·단계별 운영" meta="현재 범위 전체 SQL 집계 · 보고 비용만 합산">
        <Feedback error={models.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>모델 / 버전</th>
                <th>단계 / 프롬프트</th>
                <th className="numeric">호출 / 실패</th>
                <th className="numeric">평균 / TTFT</th>
                <th className="numeric">보고 비용 / 포함률</th>
              </tr>
            </thead>
            <tbody>
              {models.data?.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {String(r.provider)}/{String(r.model)}
                    <small className="cell-detail">{String(r.model_version)}</small>
                  </td>
                  <td>
                    {String(r.stage)}
                    <small className="cell-detail">{String(r.prompt_version)}</small>
                  </td>
                  <td className="numeric">
                    {number(Number(r.count), 0)} / {number(Number(r.errors), 0)}
                  </td>
                  <td className="numeric">
                    {number(Number(r.average_ms), 1)} /{' '}
                    {r.ttft_ms === null ? '미제공' : number(Number(r.ttft_ms), 1)} ms
                  </td>
                  <td className="numeric">
                    {r.cost_usd === null ? '미제공' : '$' + number(Number(r.cost_usd), 4)} /{' '}
                    {number((100 * Number(r.cost_count)) / Number(r.count), 1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!models.data?.rows.length && <Empty>AI 메타데이터가 있는 스팬을 수집하세요.</Empty>}
      </Panel>
      <Panel
        title="품질 평가와 회귀"
        meta="구조화된 expected/actual의 필드별 일치 평가 · 모델을 호출하는 평가가 아닙니다"
        action={
          <div className="row-actions">
            <button
              className="button secondary"
              disabled={!p.canWrite}
              onClick={() => setForm('dataset')}
            >
              데이터셋 등록
            </button>
            <button
              className="button"
              disabled={!p.canWrite || !datasets.data?.items.length}
              onClick={() => {
                setDatasetId(datasets.data?.items[0]?.id ?? '');
                setForm('run');
              }}
            >
              평가 실행
            </button>
          </div>
        }
      >
        <Feedback error={datasets.error ?? runs.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>데이터셋 / 버전</th>
                <th>모델 / 프롬프트</th>
                <th className="numeric">점수 / Coverage</th>
                <th className="numeric">Baseline 변화</th>
                <th>실패 표본</th>
              </tr>
            </thead>
            <tbody>
              {runs.data?.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    {datasets.data?.items.find((d) => d.id === r.datasetId)?.name ?? r.datasetId} /{' '}
                    {r.datasetVersion}
                  </td>
                  <td>
                    {r.modelVersion} / {r.promptVersion}
                  </td>
                  <td className="numeric">
                    {number(r.score * 100, 1)}% / {number(r.coverage * 100, 1)}%
                  </td>
                  <td className={'numeric ' + ((r.regression ?? 0) < 0 ? 'danger-text' : '')}>
                    {r.regression === null ? '없음' : number(r.regression * 100, 1) + ' pp'}
                  </td>
                  <td>
                    <details>
                      <summary>{r.results.filter((x) => x.score < 1).length}건</summary>
                      {r.results
                        .filter((x) => x.score < 1)
                        .map((x) => (
                          <p key={x.caseId}>
                            {x.caseId}: {x.failedFields.join(', ')}
                          </p>
                        ))}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!runs.data?.items.length && (
          <Empty>
            평가셋을 등록하고 버전별 평가를 실행하세요. 결과와 baseline 회귀를 저장합니다.
          </Empty>
        )}
      </Panel>
      {form && (
        <Dialog
          title={form === 'dataset' ? '평가 데이터셋 등록' : '버전 평가 실행'}
          onClose={() => setForm(null)}
        >
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const result = await p.mutate(
                  form === 'dataset' ? '/api/evaluation/datasets' : '/api/evaluation/runs',
                  form === 'dataset'
                    ? { name, version, cases: JSON.parse(cases) }
                    : {
                        datasetId,
                        modelVersion,
                        promptVersion,
                        baselineId: baselineId || undefined,
                        actuals: actuals.trim() ? JSON.parse(actuals) : undefined,
                      },
                );
                if (result) setForm(null);
              } catch (err) {
                p.notify((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {form === 'dataset' ? (
              <>
                <Field label="데이터셋 이름">
                  <input required value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="버전">
                  <input required value={version} onChange={(e) => setVersion(e.target.value)} />
                </Field>
                <Field label="구조화된 평가 표본">
                  <textarea
                    rows={10}
                    required
                    value={cases}
                    onChange={(e) => setCases(e.target.value)}
                  />
                </Field>
                <p className="muted">
                  민감한 원문 대신 허용된 구조화 결과를 사용하세요. 각 표본은 id, expected, actual
                  필드로 구성합니다.
                </p>
              </>
            ) : (
              <>
                <Field label="데이터셋">
                  <select required value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                    {datasets.data?.items.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} / {d.version}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="모델 버전">
                  <input
                    required
                    value={modelVersion}
                    onChange={(e) => setModelVersion(e.target.value)}
                  />
                </Field>
                <Field label="프롬프트 버전">
                  <input
                    required
                    value={promptVersion}
                    onChange={(e) => setPromptVersion(e.target.value)}
                  />
                </Field>
                <Field label="후보 실행 결과 (표본 ID별 actual, 선택)">
                  <textarea
                    rows={5}
                    placeholder={'{"case-1":{"answer_correct":false}}'}
                    value={actuals}
                    onChange={(e) => setActuals(e.target.value)}
                  />
                </Field>
                <Field label="같은 데이터셋의 baseline">
                  <select value={baselineId} onChange={(e) => setBaselineId(e.target.value)}>
                    <option value="">없음</option>
                    {runs.data?.items
                      .filter(
                        (r) =>
                          r.datasetId === datasetId &&
                          r.datasetVersion ===
                            datasets.data?.items.find((d) => d.id === datasetId)?.version,
                      )
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.modelVersion} / {r.promptVersion}
                        </option>
                      ))}
                  </select>
                </Field>
              </>
            )}
            <button className="button" disabled={!p.canWrite || busy}>
              {form === 'dataset' ? '데이터셋 저장' : '평가 실행'}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
