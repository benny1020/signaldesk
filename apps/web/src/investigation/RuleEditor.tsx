import { useState } from 'react';

import { Dialog, number } from '../components';

import type { PageProps } from '../Pages';
import { Field } from './shared';
export function RuleEditor({
  rule,
  onClose,
  ...p
}: PageProps & {
  rule: import('../../../../packages/contracts/src/index').Rule;
  onClose: () => void;
}) {
  const [name, setName] = useState(rule.name),
    [metric, setMetric] = useState(rule.metric),
    [threshold, setThreshold] = useState(String(rule.threshold)),
    [duration, setDuration] = useState(String(rule.durationSec)),
    [severity, setSeverity] = useState(rule.severity),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title="알림 규칙 편집" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const result = await p.mutate(
            '/api/rules/' + rule.id,
            { name, metric, threshold: Number(threshold), durationSec: Number(duration), severity },
            'PATCH',
          );
          setBusy(false);
          if (result) onClose();
        }}
      >
        <p className="muted">
          {rule.service} / {rule.environment} · 저장하면 규칙 버전이 변경되고 지속 시간 평가가 다시
          시작됩니다.
        </p>
        <Field label="규칙 이름">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="측정 지표">
          <input required value={metric} onChange={(e) => setMetric(e.target.value)} />
        </Field>
        <Field label="임계값">
          <input
            required
            type="number"
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>
        <Field label="지속 시간 (초)">
          <input
            required
            type="number"
            min="0"
            max="86400"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        </Field>
        <Field label="중요도">
          <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
            <option value="critical">긴급</option>
            <option value="warning">주의</option>
          </select>
        </Field>
        <button className="button" disabled={busy}>
          새 버전 저장
        </button>
      </form>
    </Dialog>
  );
}
