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
} = {
  active: false,
  projectId: null,
  filters: { stateGroup: '', priority: '', assignee: '', label: '', cycle: '' },
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
    filters: { stateGroup: '', priority: '', assignee: '', label: '', cycle: '' },
    search: '',
    loading: true,
    error: null,
    wsConnected: false,
  };

  let wsInstance: WebSocket | null = null;
  let unsubCtx: (() => void) | null = null;
  let isRefreshing = false;

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
  }

  function restoreSession(): void {
    // Validate saved project still exists
    const valid = _ppSession.projectId
      ? state.projects.some(p => p.id === _ppSession.projectId)
      : true;
    state.selectedProjectId = valid ? _ppSession.projectId : null;
    state.filters = { ..._ppSession.filters };
  }

  const root = document.createElement('div');
  Object.assign(root.style, {
    height: '100%',
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontFamily: MONO,
  });
  container.appendChild(root);

  // ── Data loading ──────────────────────────────────────────────────

  async function init(): Promise<void> {
    try {
      const health = await api.rpc('GET', 'health') as HealthResponse;
      state.configured = health.configured;
      if (!health.configured) {
        state.loading = false;
        render(api.context);
        return;
      }
      const res = await api.rpc('GET', 'projects') as { projects: PlaneProject[] };
      state.projects = res.projects ?? [];
      if (_ppSession.active) {
        // Tab switch within same session — restore where the user was
        restoreSession();
        if (state.selectedProjectId) {
          await loadProjectMeta(state.selectedProjectId);
        }
      }
      // else: fresh start — selectedProjectId stays null, shows recent items
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
      state.issues = res.issues ?? [];
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
    state.selectedProjectId = id || null;
    state.filters = { stateGroup: '', priority: '', assignee: '', label: '', cycle: '' };
    state.search = '';
    state.view = 'list';
    state.selectedIssue = null;
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
    state.filters[key] = value;
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

  async function patchState(issueId: string, stateId: string): Promise<void> {
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
    priority: string,
    labelIds: string[],
    assignees: string[]
  ): Promise<void> {
    if (!state.selectedProjectId) return;
    state.loading = true;
    render(api.context);
    try {
      await api.rpc('POST', 'issues', {
        project: state.selectedProjectId,
        name,
        priority: priority || 'none',
        label_ids: labelIds,
        assignees,
      });
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
    if (!state.search) return state.issues;
    const q = state.search.toLowerCase();
    return state.issues.filter(i =>
      i.name.toLowerCase().includes(q) ||
      String(i.sequence_id).includes(q)
    );
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
      !state.selectedProjectId
        ? `<option value="" disabled selected>— select a project —</option>`
        : '',
      ...state.projects.map(p =>
        `<option value="${p.id}" ${p.id === state.selectedProjectId ? 'selected' : ''}>${escHtml(p.identifier)} — ${escHtml(p.name)}</option>`
      ),
    ].join('');

    const selectStyle = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:0.72rem;outline:none;cursor:pointer`;
    const inputStyle  = `background:${c.surface};color:${c.text};border:1px solid ${c.border};border-radius:4px;padding:4px 8px;font-family:${MONO};font-size:0.72rem;outline:none;flex:1;max-width:200px`;
    const btnStyle    = `background:transparent;border:1px solid ${c.border};color:${c.muted};border-radius:3px;padding:4px 10px;font-family:${MONO};font-size:0.7rem;cursor:pointer`;

    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em;flex-shrink:0">
        ${project ? `${escHtml(project.identifier)}<span style="color:${c.accent}">▌</span>` : `Plane<span style="color:${c.accent}">▌</span>`}
      </div>
      <select id="pp-project-sel" style="${selectStyle}">${projectOptions}</select>
      <input id="pp-search" type="text" placeholder="search..." value="${state.search.replace(/"/g, '&quot;')}" style="${inputStyle}">
      <button id="pp-btn-new" style="${btnStyle}" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">+ new issue</button>
      ${state.view !== 'list' ? `<button id="pp-btn-back" style="${btnStyle}" onmouseover="this.style.borderColor='${c.accent}';this.style.color='${c.accent}'" onmouseout="this.style.borderColor='${c.border}';this.style.color='${c.muted}'">← back</button>` : ''}
      <span style="font-size:0.55rem;color:${isRefreshing ? c.warn : state.wsConnected ? c.ok : c.muted};margin-left:auto">${isRefreshing ? '↻ loading' : state.wsConnected ? '● live' : '○ offline'}</span>
    </div>`;
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

    // All-projects mode: only state + priority (assignee/label/cycle are per-project)
    if (!state.selectedProjectId) {
      return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
        <select id="pp-f-state" style="${selectStyle(!!state.filters.stateGroup)}">${stateOpts}</select>
        <select id="pp-f-prio" style="${selectStyle(!!state.filters.priority)}">${prioOpts}</select>
      </div>`;
    }

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

    return `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
      <select id="pp-f-state" style="${selectStyle(!!state.filters.stateGroup)}">${stateOpts}</select>
      <select id="pp-f-prio" style="${selectStyle(!!state.filters.priority)}">${prioOpts}</select>
      <select id="pp-f-assignee" style="${selectStyle(!!state.filters.assignee)}">${assigneeOpts}</select>
      <select id="pp-f-label" style="${selectStyle(!!state.filters.label)}">${labelOpts}</select>
      <select id="pp-f-cycle" style="${selectStyle(!!state.filters.cycle)}">${cycleOpts}</select>
    </div>`;
  }

  function buildIssueRow(issue: PlaneIssue, c: ReturnType<typeof themeColors>, idx: number): string {
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

    const rowInteractive = !isAllProjects;
    return `<div class="pp-up" style="animation-delay:${idx * 0.03}s">
      <div class="pp-issue-row" data-id="${issue.id}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid ${c.border};cursor:${rowInteractive ? 'pointer' : 'default'}" ${rowInteractive ? `onmouseover="this.style.background='${c.dim}'" onmouseout="this.style.background='transparent'"` : ''}>
        <span style="font-size:0.65rem;color:${pColor};flex-shrink:0;width:20px;text-align:center">${pIcon}</span>
        <div style="width:6px;height:6px;border-radius:50%;background:${dot};flex-shrink:0"></div>
        <span style="font-size:0.6rem;color:${c.muted};flex-shrink:0;min-width:60px">${escHtml(identifier)}</span>
        <span style="flex:1;font-size:0.72rem;color:${c.text};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(issue.name)}</span>
        ${dateStr}
        <span style="font-size:0.55rem;color:${c.muted};flex-shrink:0">${ago(issue.updated_at)}</span>
        ${stateEl}
      </div>
    </div>`;
  }

  function buildIssueList(c: ReturnType<typeof themeColors>): string {
    const issues = filteredIssues();
    if (issues.length === 0) {
      return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:40%;gap:14px">
        <pre style="font-size:0.75rem;color:${c.muted};opacity:0.5;line-height:1.6;text-align:center">  ·  ·  ·\n</pre>
        <div style="font-size:0.72rem;color:${c.muted};letter-spacing:0.1em;text-transform:uppercase">no issues</div>
      </div>`;
    }
    return issues.map((issue, i) => buildIssueRow(issue, c, i)).join('');
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
      <div style="font-size:0.6rem;color:${c.muted};margin-bottom:8px">${escHtml(identifier)}</div>
      <div style="font-size:1.1rem;font-weight:700;color:${c.text};margin-bottom:16px;line-height:1.4">${escHtml(issue.name)}</div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <div style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">state</span>
          <select id="pp-detail-state" style="${selectStyle}">${stateOpts}</select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">priority</span>
          <select id="pp-detail-prio" style="${selectStyle}">${prioOpts}</select>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:0.55rem;color:${c.muted};text-transform:uppercase;letter-spacing:0.1em">assignees</span>
          <span style="font-size:0.7rem;color:${c.text}">${assigneeNames}</span>
        </div>
        ${issue.target_date ? `<div style="display:flex;flex-direction:column;gap:4px">
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
      ...state.members.map(m => `<option value="${m.id}">${escHtml(m.display_name)}</option>`),
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
      content = `${buildHeader(c, dark)}${buildFilters(c)}<div id="pp-issue-list">${buildIssueList(c)}</div>`;
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

    // Search
    const searchInput = root.querySelector<HTMLInputElement>('#pp-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        state.search = searchInput.value;
        const list = root.querySelector<HTMLElement>('#pp-issue-list');
        if (list) list.innerHTML = buildIssueList(c);
      });
    }

    // New issue button
    root.querySelector('#pp-btn-new')?.addEventListener('click', () => {
      state.view = 'create';
      render(api.context);
    });

    // Back button
    root.querySelector('#pp-btn-back')?.addEventListener('click', () => {
      state.view = 'list';
      state.selectedIssue = null;
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

    // Issue row clicks (only active when a project is selected)
    root.querySelectorAll<HTMLElement>('.pp-issue-row').forEach(row => {
      row.addEventListener('click', () => {
        if (!state.selectedProjectId) return;
        const id = row.dataset['id'];
        if (id) void openDetail(id);
      });
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
        } catch (err) {
          state.error = (err as Error).message;
          render(api.context);
        }
      });
    }

    // Create form: submit
    root.querySelector('#pp-create-submit')?.addEventListener('click', () => {
      const title    = (root.querySelector<HTMLInputElement>('#pp-create-title'))?.value.trim() ?? '';
      const prio     = (root.querySelector<HTMLSelectElement>('#pp-create-prio'))?.value ?? '';
      const labelId  = (root.querySelector<HTMLSelectElement>('#pp-create-label'))?.value ?? '';
      const assignee = (root.querySelector<HTMLSelectElement>('#pp-create-assignee'))?.value ?? '';
      if (!title) return;
      void createIssue(title, prio, labelId ? [labelId] : [], assignee ? [assignee] : []);
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
