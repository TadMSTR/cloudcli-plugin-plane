// ── Plane API types ────────────────────────────────────────────────────

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  description: string;
}

export interface PlaneState {
  id: string;
  name: string;
  color: string;
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  sequence: number;
}

export interface PlaneMember {
  id: string;
  display_name: string;
  avatar: string;
}

export interface PlaneLabel {
  id: string;
  name: string;
  color: string;
}

export interface PlaneCycle {
  id: string;
  name: string;
  status: 'current' | 'upcoming' | 'completed';
  start_date: string | null;
  end_date: string | null;
}

export interface PlaneIssue {
  id: string;
  sequence_id: number;
  project: string;            // project UUID (present on workspace-level issue list)
  name: string;
  description_stripped: string | null;
  description_html: string | null;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  state: string;              // state UUID
  state_detail: PlaneState;
  assignees: string[];        // member UUIDs
  label_details: PlaneLabel[];
  created_at: string;
  updated_at: string;
  target_date: string | null;
  completed_at: string | null;
}

export interface PlaneComment {
  id: string;
  comment_stripped: string;
  actor_detail: { display_name: string };
  created_at: string;
}

// ── Backend config ─────────────────────────────────────────────────────

export interface PluginConfig {
  planeUrl: string;
  apiKey: string;
  workspaceSlug: string;
}

// ── Backend request/response types ────────────────────────────────────

export interface HealthResponse {
  status: string;
  configured: boolean;
  version: string;
  planeUrl?: string;
  workspaceSlug?: string;
}

export interface IssueListQuery {
  project: string;
  state_group?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  cycle?: string;
  search?: string;
}

export interface IssueListResponse {
  issues: PlaneIssue[];
  total: number;
}

export interface IssueDetailResponse {
  issue: PlaneIssue;
  comments: PlaneComment[];
}

// ── Frontend plugin API surface (provided by CloudCLI host) ───────────

export interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  error: string;
}

export interface PluginContext {
  theme: 'dark' | 'light';
  [key: string]: unknown;
}

export interface PluginAPI {
  context: PluginContext;
  onContextChange(cb: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

// ── Frontend app state ─────────────────────────────────────────────────

export type ViewMode = 'list' | 'detail' | 'create' | 'cycles';

export interface AppFilters {
  stateGroup: string;
  priority: string;
  assignee: string;
  label: string;
  cycle: string;
}

export interface AppState {
  configured: boolean;
  projects: PlaneProject[];
  selectedProjectId: string | null;  // null = all-projects view
  issueCounts: Record<string, number>; // open issue count per project UUID
  states: PlaneState[];
  members: PlaneMember[];
  labels: PlaneLabel[];
  cycles: PlaneCycle[];
  issues: PlaneIssue[];
  selectedIssue: PlaneIssue | null;
  comments: PlaneComment[];
  view: ViewMode;
  filters: AppFilters;
  search: string;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;
}
