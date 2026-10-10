import { useState } from 'react';

import { Panel, Empty, number } from '../components';
import { request, queryString } from '../api';
import type { PageProps } from '../Pages';
import { useData } from './shared';
export function EvidenceAssistant(p: PageProps) {
  const boot = useData<{ diagnosisDestination: string | null }>('/api/bootstrap', p),
    [external, setExternal] = useState(false),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{
      mode: string;
      truncated: boolean;
      hypotheses: {
        hypothesis: string;
        supportingEvidence: string[];
        counterEvidence: string[];
        missingEvidence: string[];
        nextCheck: string;
      }[];
      evidence: { id: string; kind: string; service: string; count: number; errors: number }[];
    } | null>(null);
  return (
    <Panel
      title="근거 기반 조사 보조"
      meta="가설·근거·반증·추가 확인을 함께 검토"
      action={
        <button
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setResult(
                await request('/api/diagnosis?' + queryString(p.params), {
                  method: 'POST',
                  body: JSON.stringify({ external }),
                }),
              );
            } catch (err) {
              p.notify((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '근거 분석 중' : '현재 범위 분석'}
        </button>
      }
    >
      {boot.data?.diagnosisDestination ? (
        <label className="checkbox assistant-consent">
          <input
            type="checkbox"
            checked={external}
            onChange={(e) => setExternal(e.target.checked)}
          />
          {boot.data.diagnosisDestination}에 서비스 식별자·발생 시각·집계 수치를 전달하는 데
          동의합니다. 원문 로그·프롬프트는 전달하지 않습니다.
        </label>
      ) : (
        <p className="muted assistant-consent">
          현재는 로컬 규칙 기반 분석입니다. 외부 모델 게이트웨이는 운영자가 설정할 수 있습니다.
        </p>
      )}
      {result && (
        <>
          <div className="notice">
            {result.mode === 'gateway-model'
              ? '외부 모델이 제시한 조사 가설'
              : '로컬 규칙 기반 조사 가설'}{' '}
            · 근본 원인 확정이나 자동 변경을 수행하지 않습니다.
            {result.truncated ? ' · 집계 그룹 상한 도달' : ''}
          </div>
          {result.hypotheses.map((h, i) => (
            <article className="hypothesis" key={i}>
              <strong>{h.hypothesis}</strong>
              <dl className="detail-list">
                <dt>근거</dt>
                <dd>{h.supportingEvidence.join(', ')}</dd>
                <dt>반증</dt>
                <dd>{h.counterEvidence.join(', ') || '미제공'}</dd>
                <dt>부족한 근거</dt>
                <dd>{h.missingEvidence.join(' / ')}</dd>
                <dt>다음 확인</dt>
                <dd>{h.nextCheck}</dd>
              </dl>
            </article>
          ))}
          {!result.hypotheses.length && (
            <Empty>현재 근거에서 조사 가설을 찾지 못했습니다. 수집 상태와 범위를 확인하세요.</Empty>
          )}
          <details className="assistant-evidence">
            <summary>분석에 사용한 근거 {result.evidence.length}건</summary>
            <table>
              <thead>
                <tr>
                  <th>근거 ID</th>
                  <th>서비스</th>
                  <th>관측 / 실패</th>
                </tr>
              </thead>
              <tbody>
                {result.evidence.map((e) => (
                  <tr key={e.id}>
                    <td>{e.id}</td>
                    <td>{e.service}</td>
                    <td>
                      {e.count} / {e.errors ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  );
}
