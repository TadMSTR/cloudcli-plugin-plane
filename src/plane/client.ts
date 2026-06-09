/**
 * Plane REST API client.
 * Thin fetch wrapper — no caching (backend TTL map handles that).
 */

import type {
  PlaneProject,
  PlaneState,
  PlaneMember,
  PlaneLabel,
  PlaneCycle,
  PlaneIssue,
  PlaneComment,
  PluginConfig,
} from '../types.js';

export class PlaneClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly workspaceSlug: string;

  constructor(config: PluginConfig) {
    this.baseUrl = config.planeUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.workspaceSlug = config.workspaceSlug;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Plane API ${res.status} ${res.statusText}: ${path}`);
    }
    return res.json() as Promise<T>;
  }

  private async patch<T>(path: string, body: Partial<PlaneIssue>): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Plane API ${res.status} ${res.statusText}: PATCH ${path}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Plane API ${res.status} ${res.statusText}: POST ${path}`);
    }
    return res.json() as Promise<T>;
  }

  private ws(): string {
    return `/workspaces/${this.workspaceSlug}`;
  }

  // ── Projects ──────────────────────────────────────────────────────────

  async listProjects(): Promise<PlaneProject[]> {
    const data = await this.get<{ results?: PlaneProject[] } | PlaneProject[]>(
      `${this.ws()}/projects/`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  // ── Project metadata ──────────────────────────────────────────────────

  async listStates(projectId: string): Promise<PlaneState[]> {
    const data = await this.get<{ results?: PlaneState[] } | PlaneState[]>(
      `${this.ws()}/projects/${projectId}/states/`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  async listMembers(projectId: string): Promise<PlaneMember[]> {
    const data = await this.get<{ results?: PlaneMember[] } | PlaneMember[]>(
      `${this.ws()}/projects/${projectId}/members/`
    );
    const raw = Array.isArray(data) ? data : (data.results ?? []);
    // Members endpoint returns { member: {...} } objects in some versions
    return raw.map((m: PlaneMember & { member?: PlaneMember }) => m.member ?? m);
  }

  async listLabels(projectId: string): Promise<PlaneLabel[]> {
    const data = await this.get<{ results?: PlaneLabel[] } | PlaneLabel[]>(
      `${this.ws()}/projects/${projectId}/labels/`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  async listCycles(projectId: string): Promise<PlaneCycle[]> {
    const data = await this.get<{ results?: PlaneCycle[] } | PlaneCycle[]>(
      `${this.ws()}/projects/${projectId}/cycles/`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  // ── Issues ────────────────────────────────────────────────────────────

  async listIssues(
    projectId: string,
    filters: {
      state_group?: string;
      priority?: string;
      assignee?: string;
      label?: string;
    } = {}
  ): Promise<PlaneIssue[]> {
    const params = new URLSearchParams();
    if (filters.state_group) params.set('state__group', filters.state_group);
    if (filters.priority)    params.set('priority', filters.priority);
    if (filters.assignee)    params.set('assignees', filters.assignee);
    if (filters.label)       params.set('label', filters.label);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const data = await this.get<{ results?: PlaneIssue[] } | PlaneIssue[]>(
      `${this.ws()}/projects/${projectId}/issues/${qs}`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  async getIssue(projectId: string, issueId: string): Promise<PlaneIssue> {
    return this.get<PlaneIssue>(
      `${this.ws()}/projects/${projectId}/issues/${issueId}/`
    );
  }

  async listComments(projectId: string, issueId: string): Promise<PlaneComment[]> {
    const data = await this.get<{ results?: PlaneComment[] } | PlaneComment[]>(
      `${this.ws()}/projects/${projectId}/issues/${issueId}/comments/`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  async updateIssue(
    projectId: string,
    issueId: string,
    updates: Partial<PlaneIssue>
  ): Promise<PlaneIssue> {
    return this.patch<PlaneIssue>(
      `${this.ws()}/projects/${projectId}/issues/${issueId}/`,
      updates
    );
  }

  async createIssue(
    projectId: string,
    issue: { name: string; description_html?: string; priority?: string; label_ids?: string[]; assignees?: string[] }
  ): Promise<PlaneIssue> {
    return this.post<PlaneIssue>(
      `${this.ws()}/projects/${projectId}/issues/`,
      issue as Record<string, unknown>
    );
  }

  // ── Workspace-level issues ────────────────────────────────────────────

  async listWorkspaceIssues(filters: {
    state_group?: string;
    priority?: string;
    order_by?: string;
  } = {}): Promise<PlaneIssue[]> {
    const params = new URLSearchParams();
    if (filters.state_group) params.set('state__group', filters.state_group);
    if (filters.priority)    params.set('priority', filters.priority);
    params.set('order_by', filters.order_by ?? '-created_at');
    const data = await this.get<{ results?: PlaneIssue[] } | PlaneIssue[]>(
      `${this.ws()}/issues/?${params.toString()}`
    );
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  // ── Cycles ────────────────────────────────────────────────────────────

  async listCycleIssues(projectId: string, cycleId: string): Promise<PlaneIssue[]> {
    const data = await this.get<{ results?: Array<{ issue_detail: PlaneIssue }> } | Array<{ issue_detail: PlaneIssue }>>(
      `${this.ws()}/projects/${projectId}/cycles/${cycleId}/cycle-issues/`
    );
    const raw = Array.isArray(data) ? data : (data.results ?? []);
    return raw.map(r => r.issue_detail).filter(Boolean);
  }
}
