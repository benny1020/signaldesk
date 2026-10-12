/// <reference lib="webworker" />
import ELK from 'elkjs/lib/elk.bundled.js';
const layout = new ELK();
self.onmessage = async (
  event: MessageEvent<{ ids: string[]; links: { id: string; source: string; target: string }[] }>,
) => {
  try {
    const graph = await layout.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '36',
        'elk.layered.spacing.nodeNodeBetweenLayers': '105',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      },
      children: event.data.ids.map((id) => ({ id, width: 222, height: 168 })),
      edges: event.data.links.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });
    self.postMessage({
      positions: Object.fromEntries(
        (graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]),
      ),
    });
  } catch {
    self.postMessage({ error: '지도 배치에 실패했습니다. 연결 목록에서 조사할 수 있습니다.' });
  }
};
