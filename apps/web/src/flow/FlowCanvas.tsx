import { memo, useEffect, useMemo, useState, useRef, type RefObject } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesInitialized,
  useReactFlow,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Globe, Box, Cloud, Database } from 'lucide-react';
import ELK from 'elkjs/lib/elk-api.js';
import ELKWorker from 'elkjs/lib/elk-worker.min.js?worker';
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
        {n.type === 'workload' ? `${n.region} / ${n.module}` : '호출하는 쪽에서 측정'}
      </span>
      <div className="flow-node-count">
        <span>
          {n.type === 'dependency'
            ? `호출 ${data.incoming.toLocaleString()}`
            : data.incoming
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
function FitMeasuredGraph({ container }: { container: RefObject<HTMLDivElement | null> }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized || !container.current) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.06, maxZoom: 1 }));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container.current);
    fit();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [initialized, fitView, container]);
  return null;
}
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
  const container = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({}),
    [positionKey, setPositionKey] = useState(''),
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
    // Use ELK's real browser worker: the bundled fallback expects a DOM context.
    const layout = new ELK({ workerFactory: () => new ELKWorker() });
    layout
      .layout({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.spacing.nodeNode': '28',
          'elk.layered.spacing.nodeNodeBetweenLayers': '62',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        },
        children: ids.map((id) => ({ id, width: 196, height: 156 })),
        edges: shown.map((g) => ({
          id: g[0].source + g[0].target,
          sources: [g[0].source],
          targets: [g[0].target],
        })),
      })
      .then((graph) => {
        if (!stopped) {
          setPositions(
            Object.fromEntries(
              (graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]),
            ),
          );
          setPositionKey(layoutKey);
        }
      })
      .catch(() => {
        if (!stopped) setLayoutError('지도 배치에 실패했습니다. 연결 목록에서 조사할 수 있습니다.');
      })
      .finally(() => layout.terminateWorker());
    return () => {
      stopped = true;
      layout.terminateWorker();
    };
  }, [layoutKey]);
  const nodes: Node<NodeData>[] = ids.map((id) => {
    const identity = data.nodes.find((n) => n.id === id)!,
      incoming = edges.filter((e) => e.target === id),
      outgoing = edges.filter((e) => e.source === id);
    return {
      id,
      type: 'workload',
      width: 196,
      height: 156,
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
      color = failed ? '#c23f57' : focus ? '#315cc8' : '#2c6e7b';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: `${count.toLocaleString()}건`,
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
      ariaLabel: `${data.nodes.find((n) => n.id === e.source)?.name}에서 ${data.nodes.find((n) => n.id === e.target)?.name}, ${count}건, 실패 ${failed}건, 최대 route p95 ${Math.round(p95)}ms`,
    };
  });
  const ready = positionKey === layoutKey && ids.every((id) => positions[id]);
  return (
    <div className="flow-canvas" ref={container} aria-label="요청 흐름 지도">
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
          fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
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
          <FitMeasuredGraph container={container} />
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
