import type { RequestFlow } from '../../../../packages/contracts/src/index';

// Attribute an observation to its instrumented workload, never to a provider's location.
export function regionalFlows(data: RequestFlow) {
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const regions = new Map(
    data.nodes
      .filter((node) => node.type === 'workload')
      .map((node) => [
        node.region,
        {
          region: node.region,
          services: new Set<string>(),
          incoming: 0,
          outgoing: 0,
          errors: 0,
          retries: 0,
        },
      ]),
  );
  for (const node of data.nodes) {
    if (node.type === 'workload') regions.get(node.region)?.services.add(node.id);
  }
  for (const edge of data.edges) {
    const observer =
      edge.direction === 'outbound' ? nodes.get(edge.source) : nodes.get(edge.target);
    const region = observer?.type === 'workload' ? regions.get(observer.region) : undefined;
    if (!region) continue;
    if (edge.direction === 'inbound') {
      region.incoming += edge.count;
      region.errors += edge.errors;
    } else {
      region.outgoing += edge.count;
      region.retries += edge.retries;
    }
  }
  return [...regions.values()].sort((a, b) => a.region.localeCompare(b.region));
}
