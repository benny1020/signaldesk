import type { Workspace } from './index';

export const VERSION = '0.4.0';
export type Session = {
  mode: 'local' | 'token';
  actor: string;
  role: 'admin' | 'viewer';
  workspaces: Workspace[];
  defaultWorkspace: Workspace;
  canWrite: boolean;
  version: string;
};
