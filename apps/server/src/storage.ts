import type {
  Alert,
  Incident,
  Rule,
  Workspace,
  ResourceSelector,
  ResourceSummary,
  QueryScope,
  Metric,
  Page,
} from '../../../packages/contracts/src/index.ts';
import type { TelemetryStore } from './store.ts';
type Maybe<T> = T | Promise<T>;
export type Entity = { id: string; workspace: Workspace };
export type Delivery = {
  id: string;
  workspace: Workspace;
  alert_id: string;
  channel_id: string;
  status: 'pending' | 'delivered' | 'failed' | 'cancelled';
  event_key: string;
  event_type: 'firing' | 'recovery' | 'repeat';
  attempts: number;
  next_at: number;
  created_at: number;
  delivered_at: number | null;
  error: string | null;
};
export interface ControlStore {
  readonly maxEvents: number;
  readonly maxResources: number;
  readonly backend: 'sqlite' | 'postgres';
  list<T>(
    kind: string,
    workspace: Workspace,
    filter?: { ruleId?: string; activeOnly?: boolean },
  ): Maybe<T[]>;
  get<T>(kind: string, id: string, workspace: Workspace): Maybe<T | null>;
  put<T extends Entity>(kind: string, entity: T): Maybe<void>;
  rules(workspace: Workspace): Maybe<Rule[]>;
  alerts(workspace: Workspace, ruleId?: string): Maybe<Alert[]>;
  alertPage(scope: QueryScope): Maybe<Page<Alert>>;
  incidents(workspace: Workspace): Maybe<Incident[]>;
  setting(key: string): Maybe<string | null>;
  setSetting(key: string, value: string): Maybe<void>;
  audit(workspace: Workspace, actor: string, action: string, target: string): Maybe<void>;
  auditTrail(workspace: Workspace): Maybe<unknown[]>;
  deliveryStats(
    workspace: Workspace,
  ): Maybe<{ pending: number; failed: number; delivered: number; oldestPendingAt: number | null }>;
  deliveries(workspace?: Workspace, dueAt?: number): Maybe<Delivery[]>;
  updateDelivery(
    id: string,
    patch: Partial<Omit<Delivery, 'id' | 'workspace' | 'alert_id' | 'channel_id'>>,
  ): Maybe<void>;
  retryDelivery(id: string, workspace: Workspace, now: number): Maybe<boolean>;
  publishAlert(
    alert: Alert,
    channelIds: string[],
    notification?: { key: string; type: Delivery['event_type']; time: number },
  ): Maybe<void>;
  withControl<T>(fn: () => Promise<T>): Promise<T>;
  withWorker(key: string, fn: () => Promise<void>): Promise<boolean>;
  retireResource(id: string, workspace: Workspace, retired: boolean): Maybe<boolean>;
  close(): Maybe<void>;
}
export type Storage = ControlStore & TelemetryStore;
export type InventoryRow = ResourceSummary;
export type ResourcePage = Page<InventoryRow>;
export interface InventoryStore {
  inventory(scope: QueryScope): Maybe<ResourcePage>;
  latestMetrics(scope: QueryScope): Maybe<Page<Metric>>;
}
export type DeploymentSelector = ResourceSelector;
