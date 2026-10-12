import { useState } from 'react';

import { Plus, ArrowUpRight, Users } from 'lucide-react';
import type { CatalogService, Team } from '../../../../packages/contracts/src/index';
import { Panel, Empty, Dialog } from '../components';

import type { PageProps } from '../Pages';
import { useData, Feedback, Field } from './shared';
export function Catalog(p: PageProps) {
  const q = useData<{
    teams: Team[];
    services: (CatalogService & { owner: Team | null })[];
    unowned: string[];
    inventoryTruncated: boolean;
  }>('/api/catalog', p);
  const [form, setForm] = useState<'service' | 'team' | null>(null),
    [editing, setEditing] = useState<CatalogService | null>(null);
  const [name, setName] = useState(''),
    [teamId, setTeamId] = useState(''),
    [runbook, setRunbook] = useState(''),
    [repository, setRepository] = useState(''),
    [regions, setRegions] = useState(''),
    [aliases, setAliases] = useState(''),
    [criticality, setCriticality] = useState('standard'),
    [contact, setContact] = useState(''),
    [busy, setBusy] = useState(false);
  function open(s?: CatalogService) {
    setEditing(s ?? null);
    setName(s?.name ?? '');
    setTeamId(s?.teamId ?? '');
    setRunbook(s?.runbook ?? '');
    setRepository(s?.repository ?? '');
    setRegions(s?.regions.join(', ') ?? '');
    setAliases(s?.aliases.join(', ') ?? '');
    setCriticality(s?.criticality ?? 'standard');
    setForm('service');
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const result = await p.mutate(
      form === 'team' ? '/api/teams' : '/api/catalog/services' + (editing ? '/' + editing.id : ''),
      form === 'team'
        ? { name, contact }
        : {
            name,
            teamId: teamId || null,
            runbook,
            repository,
            regions: regions
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            aliases: aliases
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            criticality,
            description: editing?.description ?? '',
          },
      editing && form === 'service' ? 'PATCH' : 'POST',
    );
    setBusy(false);
    if (result) setForm(null);
  }
  return (
    <>
      <div className="investigation-intro">
        <Users size={22} />
        <div>
          <strong>운영의 시작점은 서비스와 담당 팀입니다</strong>
          <p>담당자, 조사 자료와 지원 리전을 서비스 이름이 바뀌어도 유지합니다.</p>
        </div>
        <button
          className="button secondary"
          disabled={!p.canWrite}
          onClick={() => {
            setEditing(null);
            setName('');
            setContact('');
            setForm('team');
          }}
        >
          팀 등록
        </button>
        <button className="button" disabled={!p.canWrite} onClick={() => open()}>
          <Plus size={15} />
          서비스 등록
        </button>
      </div>
      <Feedback error={q.error} />
      <Panel title="서비스 카탈로그" meta="관측 이름 · 담당 팀 · 중요도 · 운영 자료">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>서비스</th>
                <th>담당 팀</th>
                <th>중요도</th>
                <th>지원 리전</th>
                <th>운영 자료</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.services.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button className="service-link" onClick={() => p.navigate('services', s.name)}>
                      {s.name}
                    </button>
                    <small className="cell-detail">
                      {s.aliases.length ? s.aliases.join(', ') : '별칭 없음'}
                    </small>
                  </td>
                  <td>
                    {s.owner?.name ?? <span className="warning-text">담당 미지정</span>}
                    <small className="cell-detail">{s.owner?.contact}</small>
                  </td>
                  <td>{s.criticality}</td>
                  <td>{s.regions.join(', ') || '미지정'}</td>
                  <td>
                    {s.runbook && (
                      <a href={s.runbook} target="_blank" rel="noreferrer">
                        Runbook <ArrowUpRight size={12} />
                      </a>
                    )}{' '}
                    {s.repository && (
                      <a href={s.repository} target="_blank" rel="noreferrer">
                        저장소
                      </a>
                    )}
                  </td>
                  <td>
                    <button className="text-button" disabled={!p.canWrite} onClick={() => open(s)}>
                      편집
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!q.data?.services.length && (
          <Empty>서비스를 등록하고 담당 팀과 운영 자료를 연결하세요.</Empty>
        )}
      </Panel>
      <Panel title="카탈로그 연결 대기" meta="관측 중이지만 등록되지 않은 서비스">
        {' '}
        <div className="scope-chip-list">
          {q.data?.unowned.map((s) => (
            <button
              className="scope-chip"
              disabled={!p.canWrite}
              key={s}
              onClick={() => {
                open();
                setName(s);
              }}
            >
              {s} · 등록
            </button>
          ))}
          {!q.data?.unowned.length && <p className="muted">등록 대기 서비스가 없습니다.</p>}
        </div>
        {q.data?.inventoryTruncated && (
          <div className="notice">리소스 목록 상한으로 일부 미등록 서비스가 빠질 수 있습니다.</div>
        )}
      </Panel>
      {form && (
        <Dialog
          title={form === 'team' ? '담당 팀 등록' : editing ? '서비스 편집' : '서비스 등록'}
          onClose={() => setForm(null)}
        >
          <form className="form" onSubmit={save}>
            <Field label="이름">
              <input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {form === 'team' ? (
              <Field label="연락 경로">
                <input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="팀 채널 또는 담당 연락처"
                />
              </Field>
            ) : (
              <>
                <Field label="담당 팀">
                  <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                    <option value="">담당 미지정</option>
                    {q.data?.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="중요도">
                  <select value={criticality} onChange={(e) => setCriticality(e.target.value)}>
                    <option value="critical">핵심 서비스</option>
                    <option value="standard">일반 서비스</option>
                    <option value="low">낮음</option>
                  </select>
                </Field>
                <Field label="Runbook URL">
                  <input type="url" value={runbook} onChange={(e) => setRunbook(e.target.value)} />
                </Field>
                <Field label="저장소 URL">
                  <input
                    type="url"
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                  />
                </Field>
                <Field label="지원 리전 (쉼표 구분)">
                  <input value={regions} onChange={(e) => setRegions(e.target.value)} />
                </Field>
                <Field label="관측 이름 별칭 (쉼표 구분)">
                  <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
                </Field>
              </>
            )}
            <button className="button" disabled={!p.canWrite || busy}>
              저장
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}
