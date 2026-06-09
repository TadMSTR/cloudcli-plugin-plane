import type {
  PluginAPI,
  PluginContext,
  AppState,
  AppFilters,
  PlaneProject,
  PlaneState,
  PlaneMember,
  PlaneLabel,
  PlaneCycle,
  PlaneIssue,
  PlaneComment,
  IssueListResponse,
  IssueDetailResponse,
  HealthResponse,
} from './types.js';
import {
  MONO,
  themeColors,
  ensureAssets,
  ago,
  priorityIcon,
  priorityColor,
  stateColor,
  skeletonRow,
  escHtml,
} from './styles.js';

// ── Session state (module-level) ───────────────────────────────────────
// Persists across mount/unmount within the same browser context (tab switches).
// Cleared on CloudCLI restart. Fresh start → landing view. Tab switch → restore.
let _ppSession: {
  active: boolean;
  projectId: string | null;
  filters: AppFilters;
  pageSize: number;
  myIssuesMode: boolean;
  activePreset: string | null;
} = {
  active: false,
  projectId: null,
  filters: { stateGroup: '', priority: '', assignee: '', label: '', cycle: '', sortBy: 'created' },
  pageSize: 10,
  myIssuesMode: true,
  activePreset: null,
};

// ── Mount / Unmount ────────────────────────────────────────────────────

export function mount(container: HTMLElement, api: PluginAPI): void {
  ensureAssets();

  const state: AppState = {
    configured: false,
    projects: [],
    selectedProjectId: null,
    states: [],
    members: [],
    labels: [],
    cycles: [],
    issues: [],
    selectedIssue: null,
    comments: [],
    view: 'list',
    filters: { stateGroup: '', priority: '', assignee: '', label: '', cycle: '', sortBy: 'created' },
    search: '',
    loading: true,
    error: null,
    wsConnected: false,
    narrow: false,
    currentUserId: null,
    currentUserName: null,
    myIssuesMode: true,
    planeUrl: null,
    workspaceSlug: null,
  };

  let wsInstance: WebSocket | null = null;
  let unsubCtx: (() => void) | null = null;
  let isRefreshing = false;
  let currentPage = 1;
  let pageSize = _ppSession.pageSize;
  let fromLanding = false; // track when detail was opened from landing view
  let highlightIndex = -1;

  // ── Retry helper ───────────────────────────────────────────────────
  // On failure, waits 1.5 s and tries once more; shows ↻ during the wait.
  // If the retry also fails, re-throws so the caller can set state.error.
  async function withRetry(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (firstErr) {
      isRefreshing = true;
      render(api.context);
      await new Promise(r => setTimeout(r, 1500));
      isRefreshing = false;
      await fn(); // throws if still failing — caller handles it
    }
  }

  // ── Session state helpers ──────────────────────────────────────────
  function saveSession(): void {
    _ppSession.active = true;
    _ppSession.projectId = state.selectedProjectId;
    _ppSession.filters = { ...state.filters };
    _ppSession.pageSize = pageSize;
    _ppSession.myIssuesMode = state.myIssuesMode;
    _ppSession.activePreset = activePreset;
  }

  function restoreSession(): void {
    // Validate saved project still exists
    const valid = _ppSession.projectId
      ? state.projects.some(p => p.id === _ppSession.projectId)
      : true;
    state.selectedProjectId = valid ? _ppSession.projectId : null;
    state.filters = { ..._ppSession.filters };
    state.myIssuesMode = _ppSession.myIssuesMode;
  }

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontFamily: MONO,
  });
  container.appendChild(root);

  // ── Keyboard navigation ────────────────────────────────────────────
  root.tabIndex = 0;
  root.style.outline = 'none';

  root.addEventListener('keydown', (e: KeyboardEvent) => {
    // Dismiss shortcut help on any key
    if (showShortcutHelp) {
      showShortcutHelp = false;
      render(api.context);
      return;
    }

    const active = document.activeElement;
    const isInput = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;

    if (state.view === 'detail') {
      if (e.key === 'Escape') { e.preventDefault(); void goBack(); return; }
      if (isInput) return;
      if (e.key === 's') { root.querySelector<HTMLSelectElement>('#pp-detail-state')?.focus(); return; }
      if (e.key === 'p') { root.querySelector<HTMLSelectElement>('#pp-detail-prio')?.focus(); return; }
      return;
    }

    if (state.view === 'create') return;
    if (isInput) {
      if (e.key === 'Escape') { (active as HTMLElement).blur(); state.search = ''; render(api.context); }
      return;
    }
    if (state.view !== 'list') return;

    const filtered = filteredIssues();
    const total = filtered.length;
    if (e.key === 'j') {
      e.preventDefault();
      highlightIndex = highlightIndex < total - 1 ? highlightIndex + 1 : 0;
      render(api.context);
      root.querySelector('.pp-issue-row[style*="border-left:2px solid"]')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'k') {
      e.preventDefault();
      highlightIndex = highlightIndex > 0 ? highlightIndex - 1 : total - 1;
      render(api.context);
      root.querySelector('.pp-issue-row[style*="border-left:2px solid"]')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex < total) {
      e.preventDefault();
      const issue = filtered[highlightIndex];
      if (!state.selectedProjectId) {
        void openDetailFromLanding(issue.id, issue.project);
      } else {
        void openDetail(issue.id);
      }
    } else if (e.key === 'c' && state.selectedProjectId) {
      e.preventDefault();
      state.view = 'create';
      render(api.context);
    } else if (e.key === '/') {
      e.preventDefault();
      root.querySelector<HTMLInputElement>('#pp-search')?.focus();
    } else if (e.key === 'Escape') {
      highlightIndex = -1;
      render(api.context);
    }
  });

  // ── Width detection ───────────────────────────────────────────────
  const NARROW_THRESHOLD = 480;
  let resizeObserver: ResizeObserver | null = null;
  resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const wasNarrow = state.narrow;
      state.narrow = w > 0 && w < NARROW_THRESHOLD;
      if (state.narrow !== wasNarrow) render(api.context);
    }
  });
  resizeObserver.observe(root);

  // ── Data loading ──────────────────────────────────────────────────

  async function init(): Promise<void> {
    try {
      const health = await api.rpc('GET', 'health') as HealthResponse;
      state.configured = health.configured;
      if (health.planeUrl) state.planeUrl = health.planeUrl;
      if (health.workspaceSlug) state.workspaceSlug = health.workspaceSlug;
      if (!health.configured) {
        state.loading = false;
        render(api.context);
        return;
      }
      // Fetch user identity and projects in parallel
      const [meRes, projectsRes] = await Promise.all([
        api.rpc('GET', 'me').catch(() => null) as Promise<{ id: string; display_name: string } | null>,
        api.rpc('GET', 'projects') as Promise<{ projects: PlaneProject[] }>,
      ]);
      if (meRes) {
        state.currentUserId = meRes.id;
        state.currentUserName = meRes.display_name;
      }
      state.projects = projectsRes.projects ?? [];
      if (_ppSession.active) {
        // Tab switch within same session — restore where the user was
        restoreSession();
        if (state.selectedProjectId) {
          await loadProjectMeta(state.selectedProjectId);
        }
      }
      // else: fresh start — selectedProjectId stays null, shows My Issues or recent
      await withRetry(() => loadIssues());
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
    connectWs();
  }

  async function loadProjectMeta(projectId: string): Promise<void> {
    const [statesRes, membersRes, labelsRes, cyclesRes] = await Promise.all([
      api.rpc('GET', `states?project=${projectId}`) as Promise<{ states: PlaneState[] }>,
      api.rpc('GET', `members?project=${projectId}`) as Promise<{ members: PlaneMember[] }>,
      api.rpc('GET', `labels?project=${projectId}`) as Promise<{ labels: PlaneLabel[] }>,
      api.rpc('GET', `cycles?project=${projectId}`) as Promise<{ cycles: PlaneCycle[] }>,
    ]);
    state.states  = statesRes.states   ?? [];
    state.members = membersRes.members ?? [];
    state.labels  = labelsRes.labels   ?? [];
    state.cycles  = cyclesRes.cycles   ?? [];
  }

  async function loadIssues(): Promise<void> {
    if (!state.selectedProjectId) {
      // All-projects view — workspace-level endpoint, ordered newest first
      const p = new URLSearchParams();
      if (state.filters.stateGroup) p.set('state_group', state.filters.stateGroup);
      if (state.filters.priority)   p.set('priority',    state.filters.priority);
      const qs = p.toString() ? `?${p.toString()}` : '';
      const res = await api.rpc('GET', `issues${qs}`) as IssueListResponse;
      let issues = res.issues ?? [];
      // My Issues mode: filter to current user's assignments, group by state
      if (state.myIssuesMode && state.currentUserId) {
        issues = issues.filter(i => (i.assignees ?? []).includes(state.currentUserId!));
        const groupOrder: Record<string, number> = { started: 0, unstarted: 1, backlog: 2, completed: 3, cancelled: 4 };
        const prioOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
        issues.sort((a, b) => {
          const ga = groupOrder[a.state_detail?.group ?? 'backlog'] ?? 2;
          const gb = groupOrder[b.state_detail?.group ?? 'backlog'] ?? 2;
          if (ga !== gb) return ga - gb;
          const pa = prioOrder[a.priority] ?? 4;
          const pb = prioOrder[b.priority] ?? 4;
          return pa - pb;
        });
      }
      state.issues = issues;
      return;
    }
    const p = new URLSearchParams({ project: state.selectedProjectId });
    if (state.filters.stateGroup) p.set('state_group', state.filters.stateGroup);
    if (state.filters.priority)   p.set('priority',    state.filters.priority);
    if (state.filters.assignee)   p.set('assignee',    state.filters.assignee);
    if (state.filters.label)      p.set('label',       state.filters.label);
    if (state.filters.cycle)      p.set('cycle',       state.filters.cycle);
    const res = await api.rpc('GET', `issues?${p.toString()}`) as IssueListResponse;
    state.issues = res.issues ?? [];
  }

  async function loadDetail(issueId: string): Promise<void> {
    if (!state.selectedProjectId) return;
    const res = await api.rpc(
      'GET',
      `issues/${issueId}?project=${state.selectedProjectId}`
    ) as IssueDetailResponse;
    state.selectedIssue = res.issue;
    state.comments = res.comments ?? [];
  }

  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsClosed = false;

  function connectWs(): void {
    if (wsClosed) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = localStorage.getItem('auth-token');
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      const url = `${proto}//${location.host}/plugin-ws/cloudcli-plugin-plane${qs}`;
      wsInstance = new WebSocket(url);
      wsInstance.onopen  = () => { state.wsConnected = true;  render(api.context); };
      wsInstance.onclose = () => {
        state.wsConnected = false;
        render(api.context);
        if (!wsClosed && !wsReconnectTimer) {
          wsReconnectTimer = setTimeout(() => { wsReconnectTimer = null; connectWs(); }, 5000);
        }
      };
      wsInstance.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as { type: string };
          if (msg.type === 'refresh') {
            void withRetry(() => loadIssues())
              .then(() => render(api.context))
              .catch(() => render(api.context)); // silent on persistent failure
          }
        } catch { /* ignore */ }
      };
    } catch { /* WS unavailable */ }
  }

  // ── Actions ────────────────────────────────────────────────────────

  async function selectProject(id: string): Promise<void> {
    state.error = null;
    state.selectedProjectId = id || null;
    state.filters = { stateGroup: '', priority: '', assignee: '', label: '', cycle: '', sortBy: 'created' };
    state.search = '';
    state.view = 'list';
    state.selectedIssue = null;
    currentPage = 1;
    fromLanding = false;
    state.loading = true;
    render(api.context);
    try {
      if (state.selectedProjectId) {
        await loadProjectMeta(state.selectedProjectId);
      } else {
        state.states  = [];
        state.members = [];
        state.labels  = [];
        state.cycles  = [];
      }
      await withRetry(() => loadIssues());
    } catch (err) {
      state.error = (err as Error).message;
    }
    saveSession();
    state.loading = false;
    render(api.context);
  }

  async function applyFilter(key: keyof AppFilters, value: string): Promise<void> {
    state.error = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (state.filters as any)[key] = value;
    currentPage = 1;
    saveSession();
    state.loading = true;
    render(api.context);
    try {
      await withRetry(() => loadIssues());
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
  }

  async function openDetail(issueId: string): Promise<void> {
    state.error = null;
    state.view = 'detail';
    state.loading = true;
    render(api.context);
    try {
      await loadDetail(issueId);
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
  }

  // Open detail from the landing view: load the issue's project meta first,
  // then show detail. Back button will return to landing.
  async function openDetailFromLanding(issueId: string, projectId: string): Promise<void> {
    state.error = null;
    fromLanding = true;
    state.selectedProjectId = projectId;
    state.view = 'detail';
    state.loading = true;
    render(api.context);
    try {
      await loadProjectMeta(projectId);
      await loadDetail(issueId);
      saveSession();
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
  }

  // Smart back: if detail was opened from landing, return there.
  // Otherwise return to the current project's issue list.
  async function goBack(): Promise<void> {
    state.error = null;
    state.selectedIssue = null;
    if (fromLanding) {
      fromLanding = false;
      state.selectedProjectId = null;
      state.states  = [];
      state.members = [];
      state.labels  = [];
      state.cycles  = [];
      state.view = 'list';
      currentPage = 1;
      _ppSession.projectId = null;
      state.loading = true;
      render(api.context);
      try {
        await withRetry(() => loadIssues());
      } catch (err) {
        state.error = (err as Error).message;
      }
      state.loading = false;
    } else {
      state.view = 'list';
    }
    render(api.context);
  }

  async function patchState(issueId: string, stateId: string): Promise<void> {
    state.error = null;
    if (!state.selectedProjectId) return;
    // Optimistic update
    const issue = state.issues.find(i => i.id === issueId);
    if (issue) {
      const newState = state.states.find(s => s.id === stateId);
      issue.state = stateId;
      if (newState) issue.state_detail = newState;
      render(api.context);
    }
    try {
      await api.rpc(
        'PATCH',
        `issues/${issueId}?project=${state.selectedProjectId}`,
        { state: stateId }
      );
    } catch (err) {
      state.error = (err as Error).message;
      // reload to correct optimistic update
      await loadIssues();
      render(api.context);
    }
  }

  async function createIssue(
    name: string,
    descriptionHtml: string,
    priority: string,
    labelIds: string[],
    assignees: string[]
  ): Promise<void> {
    if (!state.selectedProjectId) return;
    state.error = null;
    state.loading = true;
    render(api.context);
    try {
      const payload: Record<string, unknown> = {
        project: state.selectedProjectId,
        name,
        priority: priority || 'none',
        label_ids: labelIds,
        assignees,
      };
      if (descriptionHtml) payload.description_html = descriptionHtml;
      await api.rpc('POST', 'issues', payload);
      await loadIssues();
      state.view = 'list';
    } catch (err) {
      state.error = (err as Error).message;
    }
    state.loading = false;
    render(api.context);
  }

  // ── Render helpers ─────────────────────────────────────────────────

  function filteredIssues(): PlaneIssue[] {
    let issues = state.issues;
    if (state.search) {
      const q = state.search.toLowerCase();
      issues = issues.filter(i =>
        i.name.toLowerCase().includes(q) ||
        String(i.sequence_id).includes(q)
      );
    }
    // Apply preset filters
    if (activePreset === 'My open' && state.currentUserId) {
      issues = issues.filter(i => {
        const g = i.state_detail?.group;
        return (i.assignees ?? []).includes(state.currentUserId!) && g !== 'completed' && g !== 'cancelled';
      });
    } else if (activePreset === 'High priority') {
      issues = issues.filter(i => {
        const g = i.state_detail?.group;
        return (i.priority === 'urgent' || i.priority === 'high') && g !== 'completed' && g !== 'cancelled';
      });
    } else if (activePreset === 'Overdue') {
      issues = issues.filter(i => isOverdue(i));
    }
    // Apply client-side sort (skip if My Issues mode already sorted by state group)
    if (state.myIssuesMode && !state.selectedProjectId) return issues;
    const sortBy = state.filters.sortBy;
    if (sortBy === 'priority') {
      const order: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
      issues = [...issues].sort((a, b) => (order[a.priority] ?? 4) - (order[b.priority] ?? 4));
    } else if (sortBy === 'updated') {
      issues = [...issues].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    } else if (sortBy === 'due') {
      issues = [...issues].sort((a, b) => {
        if (!a.target_date && !b.target_date) return 0;
        if (!a.target_date) return 1;
        if (!b.target_date) return -1;
        return new Date(a.target_date).getTime() - new Date(b.target_date).getTime();
      });
    }
    // 'created' is the default server order (newest first), no re-sort needed
    return issues;
  }

  function isOverdue(issue: PlaneIssue): boolean {
    if (!issue.target_date) return false;
    const group = issue.state_detail?.group;
    if (group === 'completed' || group === 'cancelled') return false;
    return new Date(issue.target_date).getTime() < Date.now();
  }

  function memberName(id: string): string {
    return state.members.find(m => m.id === id)?.display_name ?? id.slice(0, 8);
  }

  // Strip HTML tags for description fallback when Plane returns description_stripped: null
  function stripHtml(html: string): string {
    return html
      .replace(/<\/?(p|li|div|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── HTML builders ──────────────────────────────────────────────────

  function buildHeader(c: ReturnType<typeof themeColors>, dark: boolean): string {
    const project = state.selectedProjectId
      ? state.projects.find(p => p.id === state.selectedProjectId)
      : null;

    const projectOptions = [
      `<option value="" ${!state.selectedProjectId ? 'selected' : ''}>all projects</option>`,
      ...state.projects.map(p =>
        `<option value="${p.id}" ${p.id === state.selectedProjectId ? 'selected' : ''}>${escHtml(p.identifier)} — ${escHtml(p.name)}</option>`
      ),
    ].join('');

    const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:0.72rem;outline:none;cursor:pointer`;
    const inputStyle  = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:0.72rem;outline:none;flex:1;max-width:200px`;
    const btnStyle    = `background:transparent;border:1px solid ${c.border};color:${c.muted};border-radius:3px;padding:4px 10px;font-family:${MONO};font-size:0.7rem;cursor:pointer`;

    const narrow = state.narrow;
    // My Issues / All Issues toggle (only in landing view with a known user)
    const myAllToggle = !state.selectedProjectId && state.currentUserId
      ? (() => {
          const myStyle = `padding:3px 8px;font-family:${MONO};font-size:0.6rem;cursor:pointer;border:1px solid ${state.myIssuesMode ? c.accent : c.border};border-radius:3px 0 0 3px;background:${state.myIssuesMode ? c.dim : 'transparent'};color:${state.myIssuesMode ? c.accent : c.muted}`;
          const allStyle = `padding:3px 8px;font-family:${MONO};font-size:0.6rem;cursor:pointer;border:1px solid ${!state.myIssuesMode ? c.accent : c.border};border-radius:0 3px 3px 0;background:${!state.myIssuesMode ? c.dim : 'transparent'};color:${!state.myIssuesMode ? c.accent : c.muted};border-left:none`;
          return `<span style="display:inline-flex;flex-shrink:0"><button id="pp-my-issues" style="${myStyle}">my issues</button><button id="pp-all-issues" style="${allStyle}">all issues</button></span>`;
        })()
      : '';
    const newBtn = state.selectedProjectId
      ? `<button id="pp-btn-new" style="${btnStyle}" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">${narrow ? '+' : '+ new issue'}</button>`
      : '';
    const backBtn = state.view !== 'list'
      ? `<button id="pp-btn-back" style="${btnStyle}" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">← back</button>`
      : '';
    const helpBtn = `<button id="pp-btn-help" style="background:transparent;border:1px solid ${c.border};color:${c.muted};border-radius:50%;width:20px;height:20px;font-family:${MONO};font-size:0.6rem;cursor:pointer;padding:0;line-height:18px;text-align:center;flex-shrink:0" title="keyboard shortcuts" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">?</button>`;

    if (narrow) {
      return `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:1.1rem;font-weight:700;letter-spacing:-0.02em;flex-shrink:0">
            ${project ? `${escHtml(project.identifier)}<span style="color:${c.accent}">▌</span>` : `Plane<span style="color:${c.accent}">▌</span>`}
          </div>
          <select id="pp-project-sel" style="${selectStyle};flex:1;min-width:0">${projectOptions}</select>
          ${myAllToggle}${newBtn}${backBtn}${helpBtn}
          <span style="font-size:0.55rem;color:${isRefreshing ? c.warn : state.wsConnected ? c.ok : c.muted}">${isRefreshing ? '↻' : state.wsConnected ? '●' : '○'}</span>
        </div>
        <input id="pp-search" type="text" placeholder="search..." value="${state.search.replace(/"/g, '&quot;')}" style="${inputStyle};max-width:none;width:100%;box-sizing:border-box">
      </div>`;
    }

    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;flex-shrink:0">
        ${project ? `${escHtml(project.identifier)}<span style="color:${c.accent}">▌</span>` : `Plane<span style="color:${c.accent}">▌</span>`}
      </div>
      <select id="pp-project-sel" style="${selectStyle}">${projectOptions}</select>
      <input id="pp-search" type="text" placeholder="search..." value="${state.search.replace(/"/g, '&quot;')}" style="${inputStyle}">
      ${myAllToggle}${newBtn}${backBtn}${helpBtn}
      <span style="font-size:0.55rem;color:${isRefreshing ? c.warn : state.wsConnected ? c.ok : c.muted};margin-left:auto">${isRefreshing ? '↻ loading' : state.wsConnected ? '● live' : '○ offline'}</span>
    </div>`;
  }

  let filtersExpanded = false;
  let showShortcutHelp = false;
  let activePreset: string | null = _ppSession.active ? (_ppSession as any).activePreset ?? null : null;

  function buildShortcutHelp(c: ReturnType<typeof themeColors>): string {
    if (!showShortcutHelp) return '';
    const key = (k: string) => `<span style="display:inline-block;min-width:24px;padding:1px 5px;background:${c.surface};border:1px solid ${c.border};border-radius:2px;text-align:center;font-size:0.6rem;color:${c.accent}">${k}</span>`;
    const row = (k: string, d: string) => `<div style="display:flex;gap:10px;align-items:center">${key(k)}<span style="font-size:0.62rem;color:${c.muted}">${d}</span></div>`;
    return `<div id="pp-help-overlay" style="background:${c.bg};border:1px solid ${c.border};border-radius:4px;padding:12px 16px;margin-bottom:12px;display:flex;flex-direction:column;gap:6px">
      <div style="font-size:0.65rem;font-weight:600;color:${c.text};margin-bottom:4px">keyboard shortcuts</div>
      ${row('j/k', 'navigate issues')}${row('Enter', 'open issue')}${row('c', 'create issue')}
      ${row('/', 'search')}${row('Esc', 'clear / back')}${row('s', 'focus state (detail)')}${row('p', 'focus priority (detail)')}
      <div style="font-size:0.5rem;color:${c.muted};margin-top:4px">press any key to dismiss</div>
    </div>`;
  }

  function buildPresetBar(c: ReturnType<typeof themeColors>): string {
    const presets = ['My open', 'High priority', 'Overdue'];
    const pills = presets.map(name => {
      const active = activePreset === name;
      return `<button class="pp-preset" data-preset="${escHtml(name)}" style="background:${active ? c.dim : 'transparent'};color:${active ? c.accent : c.muted};border:1px solid ${active ? c.accent : c.border};border-radius:12px;padding:3px 10px;font-family:${MONO};font-size:0.58rem;cursor:pointer" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${active ? c.accent : c.border}';this.style.color='${active ? c.accent : c.muted}'">${escHtml(name)}</button>`;
    }).join('');
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${pills}</div>`;
  }

  function buildFilters(c: ReturnType<typeof themeColors>): string {
    const selectStyle = (active: boolean) =>
      `background:${active ? c.dim : c.surface};color:${active ? c.accent : c.muted};border:1px solid ${active ? c.accent : c.border};border-radius:3px;padding:3px 7px;font-family:${MONO};font-size:0.62rem;outline:none;cursor:pointer`;

    const stateGroups = ['', 'backlog', 'unstarted', 'started', 'completed', 'cancelled'];
    const priorities  = ['', 'urgent', 'high', 'medium', 'low', 'none'];

    const stateOpts = stateGroups.map(g =>
      `<option value="${g}" ${state.filters.stateGroup === g ? 'selected' : ''}>${g || 'all states'}</option>`
    ).join('');
    const prioOpts = priorities.map(p =>
      `<option value="${p}" ${state.filters.priority === p ? 'selected' : ''}>${p || 'all priorities'}</option>`
    ).join('');

    const activeCount = [state.filters.stateGroup, state.filters.priority, state.filters.assignee, state.filters.label, state.filters.cycle].filter(Boolean).length;

    // Narrow mode: collapsible filter toggle
    if (state.narrow) {
      const toggleStyle = `background:${activeCount ? c.dim : c.surface};color:${activeCount ? c.accent : c.muted};border:1px solid ${activeCount ? c.accent : c.border};border-radius:3px;padding:4px 10px;font-family:${MONO};font-size:0.62rem;cursor:pointer;width:100%;text-align:left`;
      const filterSelects = state.selectedProjectId
        ? buildFilterSelectsAll(selectStyle, stateOpts, prioOpts)
        : buildFilterSelectsBasic(selectStyle, stateOpts, prioOpts);
      return `<div style="margin-bottom:12px">
        <button id="pp-filter-toggle" style="${toggleStyle}">Filters${activeCount ? ` (${activeCount})` : ''} ${filtersExpanded ? '▾' : '▸'}</button>
        ${filtersExpanded ? `<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${filterSelects}</div>` : ''}
      </div>`;
    }

    // All-projects mode: only state + priority (assignee/label/cycle are per-project)
    if (!state.selectedProjectId) {
      return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <select id="pp-f-state" style="${selectStyle(!!state.filters.stateGroup)}">${stateOpts}</select>
        <select id="pp-f-prio" style="${selectStyle(!!state.filters.priority)}">${prioOpts}</select>
      </div>`;
    }

    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      ${buildFilterSelectsAll(selectStyle, stateOpts, prioOpts)}
    </div>`;
  }

  function buildFilterSelectsBasic(
    selectStyle: (active: boolean) => string,
    stateOpts: string,
    prioOpts: string,
  ): string {
    return `<select id="pp-f-state" style="${selectStyle(!!state.filters.stateGroup)}">${stateOpts}</select>
      <select id="pp-f-prio" style="${selectStyle(!!state.filters.priority)}">${prioOpts}</select>`;
  }

  function buildFilterSelectsAll(
    selectStyle: (active: boolean) => string,
    stateOpts: string,
    prioOpts: string,
  ): string {
    if (!state.selectedProjectId) return buildFilterSelectsBasic(selectStyle, stateOpts, prioOpts);

    const assigneeOpts = [
      `<option value="" ${!state.filters.assignee ? 'selected' : ''}>all assignees</option>`,
      ...state.members.map(m =>
        `<option value="${m.id}" ${state.filters.assignee === m.id ? 'selected' : ''}>${escHtml(m.display_name)}</option>`
      ),
    ].join('');
    const labelOpts = [
      `<option value="" ${!state.filters.label ? 'selected' : ''}>all labels</option>`,
      ...state.labels.map(l =>
        `<option value="${l.id}" ${state.filters.label === l.id ? 'selected' : ''}>${escHtml(l.name)}</option>`
      ),
    ].join('');
    const cycleOpts = [
      `<option value="" ${!state.filters.cycle ? 'selected' : ''}>all cycles</option>`,
      ...state.cycles.map(cy =>
        `<option value="${cy.id}" ${state.filters.cycle === cy.id ? 'selected' : ''}>${escHtml(cy.name)}</option>`
      ),
    ].join('');

    return `<select id="pp-f-state" style="${selectStyle(!!state.filters.stateGroup)}">${stateOpts}</select>
      <select id="pp-f-prio" style="${selectStyle(!!state.filters.priority)}">${prioOpts}</select>
      <select id="pp-f-assignee" style="${selectStyle(!!state.filters.assignee)}">${assigneeOpts}</select>
      <select id="pp-f-label" style="${selectStyle(!!state.filters.label)}">${labelOpts}</select>
      <select id="pp-f-cycle" style="${selectStyle(!!state.filters.cycle)}">${cycleOpts}</select>`;
  }

  function buildIssueRow(issue: PlaneIssue, c: ReturnType<typeof themeColors>, idx: number, pageOffset: number): string {
    const sg = issue.state_detail?.group ?? 'unstarted';
    const dot = stateColor(sg, c);
    const overdue = isOverdue(issue);
    const dateStr = issue.target_date
      ? `<span style="font-size:0.55rem;color:${overdue ? c.error : c.muted}">${overdue ? '⚠ ' : ''}${new Date(issue.target_date).toLocaleDateString()}</span>`
      : '';
    const pIcon = priorityIcon(issue.priority);
    const pColor = priorityColor(issue.priority, c);

    const isAllProjects = !state.selectedProjectId;
    const project = isAllProjects
      ? state.projects.find(p => p.id === issue.project)
      : state.projects.find(p => p.id === state.selectedProjectId);
    const identifier = project ? `${project.identifier}-${issue.sequence_id}` : `#${issue.sequence_id}`;

    // In all-projects mode: static state pill (no per-project states loaded)
    // In per-project mode: inline state dropdown
    const stateSelectStyle = `background:${c.surface};color:${c.muted};border:1px solid ${c.border};border-radius:3px;padding:2px 5px;font-family:${MONO};font-size:0.55rem;outline:none;cursor:pointer;max-width:100px`;
    const stateEl = isAllProjects
      ? `<span style="font-size:0.55rem;color:${c.muted};flex-shrink:0;padding:2px 5px;border:1px solid ${c.border};border-radius:3px;white-space:nowrap">${escHtml(issue.state_detail?.name ?? sg)}</span>`
      : (() => {
          const stateOpts = state.states.map(s =>
            `<option value="${s.id}" ${s.id === issue.state ? 'selected' : ''}>${escHtml(s.name)}</option>`
          ).join('');
          return `<select class="pp-state-sel" data-id="${issue.id}" style="${stateSelectStyle}" onclick="event.stopPropagation()">${stateOpts}</select>`;
        })();

    // Sub-issue indicators
    const isChild = !!issue.parent;
    const childCount = state.issues.filter(i => i.parent === issue.id).length;
    const childPrefix = isChild ? `<span style="font-size:0.55rem;color:${c.muted};margin-right:2px">↳</span>` : '';
    const subBadge = childCount > 0 ? `<span style="font-size:0.5rem;color:${c.muted};flex-shrink:0" title="${childCount} sub-issue${childCount > 1 ? 's' : ''}">▸${childCount}</span>` : '';

    const highlighted = highlightIndex === pageOffset + idx;
    const hlBorder = highlighted ? `border-left:2px solid ${c.accent};` : 'border-left:2px solid transparent;';
    const hlBg = highlighted ? c.dim : 'transparent';

    if (state.narrow) {
      return `<div class="pp-up" style="animation-delay:${idx * 0.03}s">
        <div class="pp-issue-row" data-id="${issue.id}" data-project="${escHtml(issue.project ?? '')}" style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-bottom:1px solid ${c.border};${hlBorder}background:${hlBg};cursor:pointer" onmouseover="this.style.background='${c.dim}'" onmouseout="this.style.background='${hlBg}'">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:0.65rem;color:${pColor};flex-shrink:0;width:16px;text-align:center">${pIcon}</span>
            <div style="width:6px;height:6px;border-radius:50%;background:${dot};flex-shrink:0"></div>
            <span style="font-size:0.6rem;color:${c.muted};flex-shrink:0">${escHtml(identifier)}</span>
            ${childPrefix}<span style="flex:1;font-size:0.72rem;color:${isChild ? c.muted : c.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(issue.name)}</span>
            ${subBadge}${dateStr}
          </div>
          <div style="display:flex;align-items:center;gap:6px;padding-left:28px">
            ${stateEl}
          </div>
        </div>
      </div>`;
    }

    return `<div class="pp-up" style="animation-delay:${idx * 0.03}s">
      <div class="pp-issue-row" data-id="${issue.id}" data-project="${escHtml(issue.project ?? '')}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${c.border};${hlBorder}background:${hlBg};cursor:pointer" onmouseover="this.style.background='${c.dim}'" onmouseout="this.style.background='${hlBg}'"
        <span style="font-size:0.65rem;color:${pColor};flex-shrink:0;width:20px;text-align:center">${pIcon}</span>
        <div style="width:6px;height:6px;border-radius:50%;background:${dot};flex-shrink:0"></div>
        <span style="font-size:0.6rem;color:${c.muted};flex-shrink:0;min-width:60px">${escHtml(identifier)}</span>
        ${childPrefix}<span style="flex:1;font-size:0.72rem;color:${isChild ? c.muted : c.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(issue.name)}</span>
        ${subBadge}${dateStr}
        <span style="font-size:0.55rem;color:${c.muted};flex-shrink:0">${ago(issue.updated_at)}</span>
        ${stateEl}
      </div>
    </div>`;
  }

  function buildCountBadges(c: ReturnType<typeof themeColors>, filtered: PlaneIssue[]): string {
    if (filtered.length === 0) return '';
    const counts: Record<string, number> = {};
    for (const issue of filtered) {
      const g = issue.state_detail?.group ?? 'unstarted';
      counts[g] = (counts[g] ?? 0) + 1;
    }
    const groups = ['started', 'unstarted', 'backlog', 'completed', 'cancelled'];
    const labels: Record<string, string> = { started: 'in progress', unstarted: 'todo', backlog: 'backlog', completed: 'done', cancelled: 'cancelled' };
    const badges = groups
      .filter(g => counts[g])
      .map(g => {
        const active = state.filters.stateGroup === g;
        return `<span class="pp-count-badge" data-group="${g}" style="cursor:pointer;font-size:0.6rem;padding:2px 6px;border-radius:3px;background:${active ? c.dim : 'transparent'};color:${active ? c.accent : c.muted}" onmouseover="this.style.color='${c.accent}'" onmouseout="this.style.color='${active ? c.accent : c.muted}'">${counts[g]} <span style="color:${c.muted}">${labels[g]}</span></span>`;
      });
    badges.push(`<span style="font-size:0.6rem;color:${c.muted}">${filtered.length} total</span>`);
    const sortStyle = `background:${c.surface};color:${c.muted};border:1px solid ${c.border};border-radius:3px;padding:2px 5px;font-family:${MONO};font-size:0.55rem;outline:none;cursor:pointer;margin-left:auto`;
    const sortOpts = [
      { v: 'created', l: 'newest' }, { v: 'priority', l: 'priority' },
      { v: 'updated', l: 'updated' }, { v: 'due', l: 'due date' },
    ].map(o => `<option value="${o.v}" ${state.filters.sortBy === o.v ? 'selected' : ''}>${o.l}</option>`).join('');
    const sortSelect = `<select id="pp-sort" style="${sortStyle}" title="sort by">${sortOpts}</select>`;
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;padding:0 10px">${badges.join(`<span style="color:${c.border}">|</span>`)}${sortSelect}</div>`;
  }

  function buildIssueList(c: ReturnType<typeof themeColors>, filtered: PlaneIssue[]): string {
    if (filtered.length === 0) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:40%;gap:14px">
        <pre style="font-size:0.75rem;color:${c.muted};opacity:0.5;line-height:1.6;text-align:center">  ·  ·  ·\n</pre>
        <div style="font-size:0.72rem;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase">no issues</div>
      </div>`;
    }
    const start = (currentPage - 1) * pageSize;
    const page = pageSize > 0 ? filtered.slice(start, start + pageSize) : filtered;
    return page.map((issue, i) => buildIssueRow(issue, c, i, start)).join('');
  }

  function buildPagination(c: ReturnType<typeof themeColors>, total: number): string {
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    if (total === 0) return '';

    const btnStyle = (disabled: boolean) =>
      `background:transparent;border:1px solid ${disabled ? c.surface : c.border};color:${disabled ? c.surface : c.muted};border-radius:3px;padding:2px 8px;font-family:${MONO};font-size:0.65rem;cursor:${disabled ? 'default' : 'pointer'}`;
    const selStyle = `background:${c.surface};color:${c.muted};border:1px solid ${c.border};border-radius:3px;padding:2px 5px;font-family:${MONO};font-size:0.62rem;outline:none;cursor:pointer`;

    const pageSizeOpts = [10, 25, 50, 100, 0].map(n =>
      `<option value="${n}" ${pageSize === n ? 'selected' : ''}>${n === 0 ? 'all' : n}</option>`
    ).join('');

    const pageInfo = totalPages > 1
      ? `<button id="pp-page-prev" ${currentPage <= 1 ? 'disabled' : ''} style="${btnStyle(currentPage <= 1)}">‹</button>
         <span style="font-size:0.62rem;color:${c.muted}">${currentPage} / ${totalPages}</span>
         <button id="pp-page-next" ${currentPage >= totalPages ? 'disabled' : ''} style="${btnStyle(currentPage >= totalPages)}">›</button>`
      : '';

    return `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px 0;flex-wrap:wrap">
      ${pageInfo}
      <span style="font-size:0.55rem;color:${c.muted};margin-left:auto">${total} item${total !== 1 ? 's' : ''}</span>
      <select id="pp-page-size" style="${selStyle}" title="items per page">${pageSizeOpts}</select>
    </div>`;
  }

  function buildDetail(c: ReturnType<typeof themeColors>): string {
    const issue = state.selectedIssue;
    if (!issue) return '';

    const project = state.projects.find(p => p.id === state.selectedProjectId);
    const identifier = project ? `${project.identifier}-${issue.sequence_id}` : `#${issue.sequence_id}`;
    const sg = issue.state_detail?.group ?? 'unstarted';
    const pColor = priorityColor(issue.priority, c);

    const VALID_COLOR = /^#[0-9a-f]{3,8}$/i;
    const labelBadges = (issue.label_details ?? []).map(l => {
      const color = VALID_COLOR.test(l.color) ? l.color : '#888888';
      return `<span style="font-size:0.5rem;padding:1px 5px;border-radius:2px;background:${color}20;color:${color};text-transform:uppercase;letter-spacing:0.08em">${escHtml(l.name)}</span>`;
    }).join(' ');

    const assigneeNames = escHtml((issue.assignees ?? []).map(id => memberName(id)).join(', ') || '—');

    const stateOpts = state.states.map(s =>
      `<option value="${s.id}" ${s.id === issue.state ? 'selected' : ''}>${escHtml(s.name)}</option>`
    ).join('');
    const prioOpts = ['urgent', 'high', 'medium', 'low', 'none'].map(p =>
      `<option value="${p}" ${p === issue.priority ? 'selected' : ''}>${p}</option>`
    ).join('');

    const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:3px;padding:3px 7px;font-family:${MONO};font-size:0.65rem;outline:none;cursor:pointer`;

    const commentList = state.comments.map(comment => `
      <div style="padding:8px 0;border-bottom:1px solid ${c.border}">
        <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px">
          <span style="font-size:0.62rem;color:${c.accent}">${escHtml(comment.actor_detail.display_name)}</span>
          <span style="font-size:0.55rem;color:${c.muted}">${ago(comment.created_at)}</span>
        </div>
        <div style="font-size:0.7rem;color:${c.text};line-height:1.6">${escHtml(comment.comment_stripped)}</div>
      </div>`).join('');

    return `<div class="pp-up">
      <div style="font-size:0.6rem;color:${c.muted};margin-bottom:8px">${escHtml(identifier)}${state.planeUrl && state.workspaceSlug ? ` <a href="${state.planeUrl}/${state.workspaceSlug}/projects/${state.selectedProjectId}/issues/${issue.id}" target="_blank" rel="noopener" style="color:${c.muted};text-decoration:none;font-size:0.55rem" title="Open in Plane" onmouseover="this.style.color='${c.accent}'" onmouseout="this.style.color='${c.muted}'">↗</a>` : ''}</div>
      ${issue.parent ? (() => {
        const parentIssue = state.issues.find(i => i.id === issue.parent);
        const parentProject = parentIssue ? state.projects.find(p => p.id === parentIssue.project) : null;
        const parentLabel = parentIssue && parentProject ? `${parentProject.identifier}-${parentIssue.sequence_id}` : '';
        return parentLabel
          ? `<div style="font-size:0.55rem;color:${c.muted};margin-bottom:4px">↳ parent: <span class="pp-parent-link" data-id="${parentIssue!.id}" style="color:${c.accent};cursor:pointer;text-decoration:underline">${escHtml(parentLabel)}</span></div>`
          : `<div style="font-size:0.55rem;color:${c.muted};margin-bottom:4px">↳ sub-issue</div>`;
      })() : ''}
      <div style="font-size:1.1rem;font-weight:700;color:${c.text};margin-bottom:16px;line-height:1.4">${escHtml(issue.name)}</div>
      ${(() => {
        const subIssues = state.issues.filter(i => i.parent === issue.id);
        if (subIssues.length === 0) return '';
        const project = state.projects.find(p => p.id === state.selectedProjectId);
        const subList = subIssues.map(s => {
          const sid = project ? `${project.identifier}-${s.sequence_id}` : `#${s.sequence_id}`;
          const sg = s.state_detail?.group ?? 'unstarted';
          return `<div class="pp-sub-link" data-id="${s.id}" style="font-size:0.62rem;color:${c.muted};cursor:pointer;padding:2px 0" onmouseover="this.style.color='${c.accent}'" onmouseout="this.style.color='${c.muted}'"><span style="color:${stateColor(sg, c)}">●</span> ${escHtml(sid)} ${escHtml(s.name)}</div>`;
        }).join('');
        return `<div style="margin-bottom:12px"><div style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">${subIssues.length} sub-issue${subIssues.length > 1 ? 's' : ''}</div>${subList}</div>`;
      })()}

      <div style="display:flex;${state.narrow ? 'flex-direction:column' : ''};gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <div style="display:flex;${state.narrow ? 'align-items:center;justify-content:space-between' : 'flex-direction:column'};gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">state</span>
          <select id="pp-detail-state" style="${selectStyle}">${stateOpts}</select>
        </div>
        <div style="display:flex;${state.narrow ? 'align-items:center;justify-content:space-between' : 'flex-direction:column'};gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">priority</span>
          <select id="pp-detail-prio" style="${selectStyle}">${prioOpts}</select>
        </div>
        <div style="display:flex;${state.narrow ? 'align-items:center;justify-content:space-between' : 'flex-direction:column'};gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">assignees</span>
          <span style="font-size:0.7rem;color:${c.text}">${assigneeNames}</span>
        </div>
        ${issue.target_date ? `<div style="display:flex;${state.narrow ? 'align-items:center;justify-content:space-between' : 'flex-direction:column'};gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">due</span>
          <span style="font-size:0.7rem;color:${isOverdue(issue) ? c.error : c.text}">${new Date(issue.target_date).toLocaleDateString()}</span>
        </div>` : ''}
      </div>

      ${labelBadges ? `<div style="margin-bottom:16px;display:flex;gap:6px;flex-wrap:wrap">${labelBadges}</div>` : ''}

      ${(() => {
        const desc = issue.description_stripped || (issue.description_html ? stripHtml(issue.description_html) : '');
        return desc ? `<div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:12px;margin-bottom:16px;font-size:0.72rem;color:${c.text};line-height:1.7;white-space:pre-wrap">${escHtml(desc)}</div>` : '';
      })()}

      ${state.comments.length > 0 ? `
        <div style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">comments (${state.comments.length})</div>
        ${commentList}
      ` : ''}

      <div style="margin-top:12px;display:flex;gap:8px;align-items:flex-start">
        <input id="pp-comment-input" type="text" placeholder="add a comment..." style="flex:1;background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:3px;padding:6px 8px;font-family:${MONO};font-size:0.68rem;outline:none;box-sizing:border-box">
        <button id="pp-comment-submit" style="background:${c.accent};color:${c.bg};border:none;border-radius:3px;padding:6px 12px;font-family:${MONO};font-size:0.68rem;cursor:pointer;font-weight:600;flex-shrink:0">send</button>
      </div>
    </div>`;
  }

  function buildCreateForm(c: ReturnType<typeof themeColors>): string {
    const inputStyle  = `width:100%;background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:6px 8px;font-family:${MONO};font-size:0.72rem;outline:none;box-sizing:border-box`;
    const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:6px 8px;font-family:${MONO};font-size:0.72rem;outline:none;cursor:pointer`;
    const btnStyle    = `background:${c.accent};color:${c.bg};border:none;border-radius:3px;padding:6px 16px;font-family:${MONO};font-size:0.72rem;cursor:pointer;font-weight:600`;

    const prioOpts = ['none', 'low', 'medium', 'high', 'urgent'].map(p =>
      `<option value="${p}">${p}</option>`
    ).join('');
    const labelOpts = [
      `<option value="">— none —</option>`,
      ...state.labels.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`),
    ].join('');
    const assigneeOpts = [
      `<option value="">— none —</option>`,
      ...state.members.map(m => `<option value="${m.id}" ${m.id === state.currentUserId ? 'selected' : ''}>${escHtml(m.display_name)}</option>`),
    ].join('');

    return `<div class="pp-up" style="max-width:600px">
      <div style="font-size:0.82rem;font-weight:600;color:${c.text};margin-bottom:16px">new issue</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        <input id="pp-create-title" type="text" placeholder="issue title" style="${inputStyle}">
        <textarea id="pp-create-desc" placeholder="description (optional)" rows="4" style="${inputStyle};resize:vertical"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="pp-create-prio" style="${selectStyle}">${prioOpts}</select>
          <select id="pp-create-label" style="${selectStyle}">${labelOpts}</select>
          <select id="pp-create-assignee" style="${selectStyle}">${assigneeOpts}</select>
        </div>
        <div style="display:flex;gap:8px">
          <button id="pp-create-submit" style="${btnStyle}">create issue</button>
          <button id="pp-create-cancel" style="background:transparent;border:1px solid ${c.border};color:${c.muted};border-radius:3px;padding:6px 12px;font-family:${MONO};font-size:0.72rem;cursor:pointer">cancel</button>
        </div>
      </div>
    </div>`;
  }

  function buildUnconfigured(c: ReturnType<typeof themeColors>): string {
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60%;gap:16px">
      <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">Plane<span style="color:${c.accent}">▌</span></div>
      <div style="font-size:0.72rem;color:${c.muted}">configure plane connection</div>
      <div style="font-size:0.62rem;color:${c.muted};opacity:0.6;text-align:center;max-width:380px;line-height:1.7">
        create ~/.claude-code-ui/plugins/cloudcli-plugin-plane/config.json<br>
        with planeUrl, apiKey, and workspaceSlug
      </div>
      <div style="background:${c.surface};border:1px solid ${c.border};border-radius:3px;padding:12px 16px;font-size:0.65rem;color:${c.text};line-height:1.8">
        {<br>
        &nbsp;&nbsp;"planeUrl": "https://plane.example.com",<br>
        &nbsp;&nbsp;"apiKey": "plane_api_...",<br>
        &nbsp;&nbsp;"workspaceSlug": "your-workspace"<br>
        }
      </div>
    </div>`;
  }

  function buildSkeletons(c: ReturnType<typeof themeColors>): string {
    return [70, 85, 55, 90, 65].map((w, i) => skeletonRow(c, w, i * 0.15)).join('');
  }

  // ── Full render ────────────────────────────────────────────────────

  function render(ctx: PluginContext): void {
    const dark = ctx.theme !== 'light';
    const c = themeColors(dark);

    Object.assign(root.style, {
      background: c.bg,
      color: c.text,
      padding: '24px',
    });

    if (!state.configured) {
      root.innerHTML = buildUnconfigured(c);
      return;
    }

    let content = '';
    if (state.loading) {
      content = `${buildHeader(c, dark)}<div style="margin-top:16px">${buildSkeletons(c)}</div>`;
    } else if (state.error) {
      content = `${buildHeader(c, dark)}<div style="color:${c.error};font-size:0.72rem;padding:12px 0">${escHtml(state.error)}</div>`;
    } else if (state.view === 'create') {
      content = `${buildHeader(c, dark)}${buildCreateForm(c)}`;
    } else if (state.view === 'detail') {
      content = `${buildHeader(c, dark)}${buildDetail(c)}`;
    } else {
      const filtered = filteredIssues();
      content = `${buildHeader(c, dark)}${buildShortcutHelp(c)}${buildPresetBar(c)}${buildFilters(c)}${buildCountBadges(c, filtered)}<div id="pp-issue-list">${buildIssueList(c, filtered)}</div>${buildPagination(c, filtered.length)}`;
    }

    root.innerHTML = content;
    attachHandlers(c);
  }

  // ── Event handlers ─────────────────────────────────────────────────

  function attachHandlers(c: ReturnType<typeof themeColors>): void {
    // Project selector
    const projectSel = root.querySelector<HTMLSelectElement>('#pp-project-sel');
    if (projectSel) {
      projectSel.addEventListener('change', () => {
        void selectProject(projectSel.value);
      });
    }

    // Search — reset page on new query
    const searchInput = root.querySelector<HTMLInputElement>('#pp-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.search = searchInput.value;
        currentPage = 1;
        render(api.context);
      });
    }

    // My Issues / All Issues toggle
    root.querySelector('#pp-my-issues')?.addEventListener('click', () => {
      if (!state.myIssuesMode) {
        state.myIssuesMode = true;
        saveSession();
        state.loading = true;
        render(api.context);
        void withRetry(() => loadIssues()).then(() => { state.loading = false; render(api.context); }).catch(err => { state.error = (err as Error).message; state.loading = false; render(api.context); });
      }
    });
    root.querySelector('#pp-all-issues')?.addEventListener('click', () => {
      if (state.myIssuesMode) {
        state.myIssuesMode = false;
        saveSession();
        state.loading = true;
        render(api.context);
        void withRetry(() => loadIssues()).then(() => { state.loading = false; render(api.context); }).catch(err => { state.error = (err as Error).message; state.loading = false; render(api.context); });
      }
    });

    // New issue button
    root.querySelector('#pp-btn-new')?.addEventListener('click', () => {
      state.view = 'create';
      render(api.context);
    });

    // Help overlay
    root.querySelector('#pp-btn-help')?.addEventListener('click', () => {
      showShortcutHelp = !showShortcutHelp;
      render(api.context);
    });

    // Back button — returns to landing if that's where we came from
    root.querySelector('#pp-btn-back')?.addEventListener('click', () => {
      void goBack();
    });

    // Preset buttons
    root.querySelectorAll<HTMLElement>('.pp-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset['preset'] ?? '';
        activePreset = activePreset === preset ? null : preset;
        currentPage = 1;
        saveSession();
        render(api.context);
      });
    });

    // Sort dropdown
    root.querySelector<HTMLSelectElement>('#pp-sort')?.addEventListener('change', (e) => {
      state.filters.sortBy = (e.target as HTMLSelectElement).value as AppFilters['sortBy'];
      saveSession();
      render(api.context);
    });

    // Count badge clicks (toggle state group filter)
    root.querySelectorAll<HTMLElement>('.pp-count-badge').forEach(badge => {
      badge.addEventListener('click', () => {
        const group = badge.dataset['group'] ?? '';
        void applyFilter('stateGroup', state.filters.stateGroup === group ? '' : group);
      });
    });

    // Filter toggle (narrow mode)
    root.querySelector('#pp-filter-toggle')?.addEventListener('click', () => {
      filtersExpanded = !filtersExpanded;
      render(api.context);
    });

    // Filter selects
    const filterMap: Record<string, keyof AppFilters> = {
      '#pp-f-state':   'stateGroup',
      '#pp-f-prio':    'priority',
      '#pp-f-assignee':'assignee',
      '#pp-f-label':   'label',
      '#pp-f-cycle':   'cycle',
    };
    for (const [sel, key] of Object.entries(filterMap)) {
      root.querySelector<HTMLSelectElement>(sel)?.addEventListener('change', (e) => {
        void applyFilter(key, (e.target as HTMLSelectElement).value);
      });
    }

    // Issue row clicks — landing uses openDetailFromLanding; project uses openDetail
    root.querySelectorAll<HTMLElement>('.pp-issue-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.dataset['id'];
        if (!id) return;
        if (!state.selectedProjectId) {
          const proj = row.dataset['project'];
          if (proj) void openDetailFromLanding(id, proj);
        } else {
          void openDetail(id);
        }
      });
    });

    // Pagination controls
    root.querySelector('#pp-page-prev')?.addEventListener('click', () => {
      if (currentPage > 1) { currentPage--; render(api.context); }
    });
    root.querySelector('#pp-page-next')?.addEventListener('click', () => {
      const total = filteredIssues().length;
      const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
      if (currentPage < totalPages) { currentPage++; render(api.context); }
    });
    root.querySelector<HTMLSelectElement>('#pp-page-size')?.addEventListener('change', (e) => {
      pageSize = parseInt((e.target as HTMLSelectElement).value, 10);
      currentPage = 1;
      saveSession();
      render(api.context);
    });

    // Inline state selects on issue rows
    root.querySelectorAll<HTMLSelectElement>('.pp-state-sel').forEach(sel => {
      sel.addEventListener('change', () => {
        void patchState(sel.dataset['id'] ?? '', sel.value);
      });
    });

    // Detail view: state change
    const detailState = root.querySelector<HTMLSelectElement>('#pp-detail-state');
    if (detailState && state.selectedIssue) {
      detailState.addEventListener('change', () => {
        void patchState(state.selectedIssue!.id, detailState.value);
      });
    }

    // Detail view: priority change
    const detailPrio = root.querySelector<HTMLSelectElement>('#pp-detail-prio');
    if (detailPrio && state.selectedIssue) {
      detailPrio.addEventListener('change', async () => {
        if (!state.selectedProjectId || !state.selectedIssue) return;
        try {
          await api.rpc(
            'PATCH',
            `issues/${state.selectedIssue.id}?project=${state.selectedProjectId}`,
            { priority: detailPrio.value }
          );
          state.selectedIssue.priority = detailPrio.value as PlaneIssue['priority'];
          await loadIssues();
          render(api.context);
        } catch (err) {
          state.error = (err as Error).message;
          render(api.context);
        }
      });
    }

    // Parent/sub-issue links in detail view
    root.querySelector<HTMLElement>('.pp-parent-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      const id = (e.target as HTMLElement).dataset['id'];
      if (id) void openDetail(id);
    });
    root.querySelectorAll<HTMLElement>('.pp-sub-link').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset['id'];
        if (id) void openDetail(id);
      });
    });

    // Comment submit
    const commentSubmit = root.querySelector('#pp-comment-submit');
    const commentInput = root.querySelector<HTMLInputElement>('#pp-comment-input');
    if (commentSubmit && commentInput) {
      const doSubmit = async () => {
        const text = commentInput.value.trim();
        if (!text || !state.selectedProjectId || !state.selectedIssue) return;
        const commentHtml = `<p>${escHtml(text).replace(/\n/g, '</p><p>')}</p>`;
        commentInput.value = '';
        try {
          await api.rpc('POST', `issues/${state.selectedIssue.id}/comments?project=${state.selectedProjectId}`, { comment_html: commentHtml });
          await loadDetail(state.selectedIssue.id);
          render(api.context);
        } catch (err) {
          state.error = (err as Error).message;
          render(api.context);
        }
      };
      commentSubmit.addEventListener('click', () => void doSubmit());
      commentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSubmit(); }
      });
    }

    // Create form: submit
    root.querySelector('#pp-create-submit')?.addEventListener('click', () => {
      const title    = (root.querySelector<HTMLInputElement>('#pp-create-title'))?.value.trim() ?? '';
      const desc     = (root.querySelector<HTMLTextAreaElement>('#pp-create-desc'))?.value.trim() ?? '';
      const prio     = (root.querySelector<HTMLSelectElement>('#pp-create-prio'))?.value ?? '';
      const labelId  = (root.querySelector<HTMLSelectElement>('#pp-create-label'))?.value ?? '';
      const assignee = (root.querySelector<HTMLSelectElement>('#pp-create-assignee'))?.value ?? '';
      if (!title) return;
      const descHtml = desc ? `<p>${escHtml(desc).replace(/\n/g, '</p><p>')}</p>` : '';
      void createIssue(title, descHtml, prio, labelId ? [labelId] : [], assignee ? [assignee] : []);
    });

    // Create form: cancel
    root.querySelector('#pp-create-cancel')?.addEventListener('click', () => {
      state.view = 'list';
      render(api.context);
    });
  }

  // ── Context subscription ────────────────────────────────────────────

  unsubCtx = api.onContextChange(ctx => render(ctx));

  // ── Init ───────────────────────────────────────────────────────────

  void init();

  // ── Unmount cleanup (stored on container for CloudCLI to call) ────
  (container as HTMLElement & { __ppCleanup?: () => void }).__ppCleanup = () => {
    wsClosed = true;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    resizeObserver?.disconnect();
    resizeObserver = null;
    unsubCtx?.();
    wsInstance?.close();
    wsInstance = null;
  };
}

export function unmount(container: HTMLElement): void {
  const el = container as HTMLElement & { __ppCleanup?: () => void };
  el.__ppCleanup?.();
  container.innerHTML = '';
}
