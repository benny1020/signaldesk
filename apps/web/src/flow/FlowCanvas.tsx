import { memo, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Globe, Box, Cloud, Database } from 'lucide-react';
import type { RequestFlow, FlowNode, FlowEdge } from '../../../../packages/contracts/src/index';
type NodeData = {
  identity: FlowNode;
  errors: number;
  incoming: number;
  outgoing: number;
  selected: boolean;
} & Record<string, unknown>;
const FlowCard = memo(function FlowCard({ data }: NodeProps<Node<NodeData>>) {
  const n = data.identity,
    Icon =
      n.type === 'caller'
        ? Globe
        : n.type === 'workload'
          ? Box
          : n.name.toLowerCase().includes('postgres')
            ? Database
            : Cloud;
  return (
    <div
      className={`flow-node ${n.type} ${data.errors ? 'has-errors' : ''} ${data.selected ? 'is-focused' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-kind">
        <Icon size={15} />
        <span>
          {n.type === 'workload'
            ? '우리 서비스'
            : n.type === 'caller'
              ? '호출자 · 내부 미관측'
              : '의존 대상 · 내부 미관측'}
        </span>
      </div>
      <strong title={n.name}>{n.name}</strong>
      <span className="flow-node-place">
        {n.type === 'workload'
          ? `${n.region === 'all' ? n.regions?.length + '개 리전' : n.region} / ${n.module}`
          : '호출하는 쪽에서 측정'}
      </span>
      <div className="flow-node-count">
        <span>
          {data.incoming
            ? `진입 ${data.incoming.toLocaleString()}`
            : `호출 ${data.outgoing.toLocaleString()}`}
        </span>
        <b>{data.errors ? '실패 연결 있음' : '실패 관측 없음'}</b>
      </div>
      {n.owner && <small>{n.owner}</small>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const nodeTypes = { workload: FlowCard };
export default function FlowCanvas({
  data,
  edges,
  selected,
  onSelect,
  onFocus,
}: {
  data: RequestFlow;
  edges: FlowEdge[];
  selected?: FlowEdge;
  onSelect: (e: FlowEdge) => void;
  onFocus: (n: FlowNode) => void;
}) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({}),
    [layoutError, setLayoutError] = useState('');
  const grouped = useMemo(() => {
    const groups = new Map<string, FlowEdge[]>();
    for (const e of [...edges].sort((a, b) => b.errors - a.errors || b.count - a.count)) {
      const key = e.source + ':' + e.target;
      if (!groups.has(key) && groups.size >= 60) continue;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    return [...groups.values()];
  }, [edges]);
  const ids = useMemo(
    () => [...new Set(grouped.flatMap((g) => [g[0].source, g[0].target]))].slice(0, 50),
    [grouped],
  );
  const shown = grouped.filter((g) => ids.includes(g[0].source) && ids.includes(g[0].target));
  const layoutKey = JSON.stringify([ids, shown.map((g) => [g[0].source, g[0].target])]);
  useEffect(() => {
    let stopped = false;
    setLayoutError('');
    const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (
      e: MessageEvent<{ positions?: Record<string, { x: number; y: number }>; error?: string }>,
    ) => {
      if (stopped) return;
      if (e.data.positions) setPositions(e.data.positions);
      else setLayoutError(e.data.error ?? '배치를 완료하지 못했습니다. 숫자 목록을 사용하세요.');
      worker.terminate();
    };
    worker.onerror = () => {
      if (!stopped) setLayoutError('지도 배치를 불러오지 못했습니다. 연결 목록을 사용하세요.');
      worker.terminate();
    };
    worker.postMessage({
      ids,
      links: shown.map((g) => ({
        id: g[0].source + g[0].target,
        source: g[0].source,
        target: g[0].target,
      })),
    });
    return () => {
      stopped = true;
      worker.terminate();
    };
  }, [layoutKey]);
  const nodes: Node<NodeData>[] = ids.map((id) => {
    const identity = data.nodes.find((n) => n.id === id)!,
      incoming = edges.filter((e) => e.target === id),
      outgoing = edges.filter((e) => e.source === id);
    return {
      id,
      type: 'workload',
      position: positions[id] ?? { x: 0, y: 0 },
      data: {
        identity,
        incoming: incoming.reduce((v, e) => v + e.count, 0),
        outgoing: outgoing.reduce((v, e) => v + e.count, 0),
        errors: [...incoming, ...outgoing].reduce((v, e) => v + e.errors, 0),
        selected: selected?.source === id || selected?.target === id,
      },
      ariaLabel: `${identity.name}, ${identity.region}, ${identity.type === 'workload' ? '우리 서비스' : '내부 미관측'}`,
    };
  });
  const graphEdges: Edge[] = shown.map((group) => {
    const e = group[0],
      count = group.reduce((n, r) => n + r.count, 0),
      failed = group.reduce((n, r) => n + r.errors, 0),
      p95 = Math.max(...group.map((r) => r.p95Ms)),
      virtual =
        data.nodes.find((n) => n.id === e.target)?.type === 'dependency' ||
        data.nodes.find((n) => n.id === e.source)?.type === 'caller';
    const focus = selected?.source === e.source && selected?.target === e.target,
      color = failed ? '#c23f57' : focus ? '#315cc8' : '#468a99';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: `${count.toLocaleString()}건 · 최대 route p95 ${Math.round(p95)}ms`,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: {
        stroke: color,
        strokeWidth: focus ? 3 : Math.min(3, 1 + Math.log2(count + 1) / 5),
        strokeDasharray: virtual ? '5 4' : undefined,
        opacity: selected && !focus ? 0.45 : 1,
      },
      labelStyle: { fill: color, fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: '#f8fbfe', fillOpacity: 0.96 },
      labelBgPadding: [6, 4],
      ariaLabel: `${data.nodes.find((n) => n.id === e.source)?.name}에서 ${data.nodes.find((n) => n.id === e.target)?.name}, ${count}건, 실패 ${failed}건`,
    };
  });
  const ready = ids.every((id) => positions[id]);
  return (
    <div className="flow-canvas" aria-label="요청 흐름 지도">
      <div className="flow-map-caption">
        <span>호출자</span>
        <span>우리 서비스</span>
        <span>하위 서비스·외부 의존성</span>
      </div>
      {layoutError ? (
        <div className="empty">{layoutError}</div>
      ) : !ready ? (
        <div className="empty">요청 흐름을 배치하고 있습니다…</div>
      ) : (
        <ReactFlow
          key={layoutKey}
          nodes={nodes}
          edges={graphEdges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.8}
          onEdgeClick={(_, e) => {
            const group = shown.find((g) => g[0].id === e.id);
            if (group)
              onSelect([...group].sort((a, b) => b.errors - a.errors || b.p95Ms - a.p95Ms)[0]);
          }}
          onNodeClick={(_, n) => onFocus((n.data as NodeData).identity)}
          ariaLabelConfig={{
            'controls.zoomIn.ariaLabel': '확대',
            'controls.zoomOut.ariaLabel': '축소',
            'controls.fitView.ariaLabel': '전체 지도 맞춤',
            'controls.interactive.ariaLabel': '지도 조작',
          }}
        >
          <Background color="#ccdae5" gap={22} size={1} />
          <Controls showInteractive={false} />
          {ids.length > 10 && <MiniMap pannable zoomable nodeColor="#8bbac5" />}
        </ReactFlow>
      )}
      {(shown.length < grouped.length ||
        new Set(edges.map((e) => e.source + ':' + e.target)).size > 60) && (
        <div className="flow-map-limit">
          지도는 최대 50개 노드·60개 연결을 표시합니다. 전체 결과는 연결 목록에서 검색하세요.
        </div>
      )}
    </div>
  );
}
