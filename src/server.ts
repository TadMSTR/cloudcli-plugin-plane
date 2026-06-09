import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { PlaneClient } from './plane/client.js';
import type {
  PluginConfig,
  PlaneProject,
  PlaneState,
  PlaneMember,
  PlaneLabel,
  PlaneCycle,
  PlaneIssue,
  PlaneComment,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? os.homedir();
const CONFIG_PATH = path.join(
  HOME,
  '.claude-code-ui',
  'plugins',
  'cloudcli-plugin-plane',
  'config.json'
);
const VERSION = '0.2.0';

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig(): PluginConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as Partial<PluginConfig>;
    if (!cfg.planeUrl || !cfg.apiKey || !cfg.workspaceSlug) return null;
    // Warn if config file is world-readable (contains API key)
    try {
      const mode = fs.statSync(CONFIG_PATH).mode;
      if (mode & 0o004) {
        process.stderr.write('[cloudcli-plugin-plane] WARNING: config.json is world-readable — run: chmod 600 ' + CONFIG_PATH + '\n');
      }
    } catch { /* stat failed, ignore */ }
    return cfg as PluginConfig;
  } catch {
    return null;
  }
}

// ── TTL cache ──────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

const cache = new TtlCache();
const TTL_PROJECTS  = 60_000;
const TTL_META      = 60_000; // states, members, labels
const TTL_CYCLES    = 30_000;
const TTL_ISSUES    = 10_000;

// ── WebSocket broadcast ────────────────────────────────────────────────

const wsClients = new Set<WebSocket>();

function broadcast(msg: object): void {
  const payload = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function qs(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  return new URLSearchParams(idx >= 0 ? url.slice(idx + 1) : '');
}

// ── Route handlers ─────────────────────────────────────────────────────

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    json(res, 200, { status: 'ok', configured: false, version: VERSION });
    return;
  }
  json(res, 200, {
    status: 'ok',
    configured: true,
    version: VERSION,
    planeUrl: cfg.planeUrl,
    workspaceSlug: cfg.workspaceSlug,
  });
}

async function handleMe(res: http.ServerResponse): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const cacheKey = 'me';
  let me = cache.get<{ id: string; display_name: string }>(cacheKey);
  if (!me) {
    const client = new PlaneClient(cfg);
    me = await client.getMe();
    cache.set(cacheKey, me, TTL_META);
  }
  json(res, 200, me);
}

async function handleProjects(res: http.ServerResponse): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const cacheKey = `projects:${cfg.workspaceSlug}`;
  let projects = cache.get<PlaneProject[]>(cacheKey);
  if (!projects) {
    const client = new PlaneClient(cfg);
    projects = await client.listProjects();
    cache.set(cacheKey, projects, TTL_PROJECTS);
  }
  json(res, 200, { projects });
}

async function handleStates(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(project)) { json(res, 400, { error: 'invalid id' }); return; }

  const cacheKey = `states:${project}`;
  let states = cache.get<PlaneState[]>(cacheKey);
  if (!states) {
    const client = new PlaneClient(cfg);
    states = await client.listStates(project);
    cache.set(cacheKey, states, TTL_META);
  }
  json(res, 200, { states });
}

async function handleMembers(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(project)) { json(res, 400, { error: 'invalid id' }); return; }

  const cacheKey = `members:${project}`;
  let members = cache.get<PlaneMember[]>(cacheKey);
  if (!members) {
    const client = new PlaneClient(cfg);
    members = await client.listMembers(project);
    cache.set(cacheKey, members, TTL_META);
  }
  json(res, 200, { members });
}

async function handleLabels(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(project)) { json(res, 400, { error: 'invalid id' }); return; }

  const cacheKey = `labels:${project}`;
  let labels = cache.get<PlaneLabel[]>(cacheKey);
  if (!labels) {
    const client = new PlaneClient(cfg);
    labels = await client.listLabels(project);
    cache.set(cacheKey, labels, TTL_META);
  }
  json(res, 200, { labels });
}

async function handleCycles(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(project)) { json(res, 400, { error: 'invalid id' }); return; }

  const cacheKey = `cycles:${project}`;
  let cycles = cache.get<PlaneCycle[]>(cacheKey);
  if (!cycles) {
    const client = new PlaneClient(cfg);
    cycles = await client.listCycles(project);
    cache.set(cacheKey, cycles, TTL_CYCLES);
  }
  json(res, 200, { cycles });
}

/**
 * Fetch all issues across all projects in parallel, sorted newest first.
 * Results are cached under a single key so handleWorkspaceIssues and
 * handleIssueCounts share the same fetch — 34 parallel requests happen once,
 * then subsequent calls within TTL_ISSUES are instant.
 */
async function fetchAllWorkspaceIssues(cfg: ReturnType<typeof loadConfig> & {}): Promise<PlaneIssue[]> {
  const cacheKey = `workspace-issues-all:${cfg.workspaceSlug}`;
  const cached = cache.get<PlaneIssue[]>(cacheKey);
  if (cached) return cached;

  const client = new PlaneClient(cfg);
  const projects = await client.listProjects();
  const perProject = await Promise.all(
    projects.map(async (p) => {
      try {
        const issues = await client.listIssues(p.id, {});
        // Stamp project UUID onto each issue (per-project endpoint omits it)
        return issues.map(i => ({ ...i, project: p.id }));
      } catch {
        return [] as PlaneIssue[];
      }
    })
  );
  const issues = perProject.flat().sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  cache.set(cacheKey, issues, TTL_ISSUES);
  return issues;
}

async function handleWorkspaceIssues(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const stateGroup = params.get('state_group') ?? '';
  const priority   = params.get('priority')    ?? '';

  let issues = await fetchAllWorkspaceIssues(cfg);
  // Apply filters client-side — data already cached, no extra Plane calls
  if (stateGroup) issues = issues.filter(i => (i.state_detail?.group ?? '') === stateGroup);
  if (priority)   issues = issues.filter(i => i.priority === priority);

  json(res, 200, { issues, total: issues.length });
}

async function handleIssueCounts(res: http.ServerResponse): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const cacheKey = `issue-counts:${cfg.workspaceSlug}`;
  let counts = cache.get<Record<string, number>>(cacheKey);
  if (!counts) {
    const issues = await fetchAllWorkspaceIssues(cfg);
    counts = {};
    for (const issue of issues) {
      if (!issue.project) continue;
      const g = issue.state_detail?.group;
      if (g === 'completed' || g === 'cancelled') continue;
      counts[issue.project] = (counts[issue.project] ?? 0) + 1;
    }
    cache.set(cacheKey, counts, TTL_PROJECTS);
  }
  json(res, 200, { counts });
}

async function handleIssueList(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(project)) { json(res, 400, { error: 'invalid id' }); return; }

  const filters = {
    state_group: params.get('state_group') ?? undefined,
    priority:    params.get('priority')    ?? undefined,
    assignee:    params.get('assignee')    ?? undefined,
    label:       params.get('label')       ?? undefined,
  };
  const cycleId = params.get('cycle');

  if (cycleId && !VALID_UUID.test(cycleId)) { json(res, 400, { error: 'invalid id' }); return; }

  const cacheKey = `issues:${project}:${JSON.stringify(filters)}:${cycleId ?? ''}`;
  let issues = cache.get<PlaneIssue[]>(cacheKey);
  if (!issues) {
    const client = new PlaneClient(cfg);
    if (cycleId) {
      issues = await client.listCycleIssues(project, cycleId);
    } else {
      issues = await client.listIssues(project, filters);
    }
    cache.set(cacheKey, issues, TTL_ISSUES);
  }
  json(res, 200, { issues, total: issues.length });
}

async function handleIssueDetail(
  res: http.ServerResponse,
  projectId: string,
  issueId: string
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const client = new PlaneClient(cfg);
  const [issue, comments] = await Promise.all([
    client.getIssue(projectId, issueId),
    client.listComments(projectId, issueId),
  ]);
  json(res, 200, { issue, comments });
}

async function handleCommentCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
  issueId: string
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const body = await parseBody(req);
  const commentHtml = body.comment_html;
  if (!commentHtml || typeof commentHtml !== 'string') { json(res, 400, { error: 'comment_html required' }); return; }

  const client = new PlaneClient(cfg);
  const comment = await client.createComment(projectId, issueId, commentHtml);
  broadcast({ type: 'refresh' });
  json(res, 201, { comment });
}

async function handleIssueUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
  issueId: string
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const body = await parseBody(req);
  const client = new PlaneClient(cfg);
  const issue = await client.updateIssue(projectId, issueId, body as Partial<PlaneIssue>);

  cache.invalidate(`issues:${projectId}`);
  cache.invalidate('workspace-issues-all:');
  cache.invalidate('issue-counts:');
  broadcast({ type: 'refresh' });
  json(res, 200, { issue });
}

async function handleIssueCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }

  const body = await parseBody(req);
  const projectId = body.project as string;
  if (!projectId) { json(res, 400, { error: 'project required' }); return; }
  if (!VALID_UUID.test(projectId)) { json(res, 400, { error: 'invalid id' }); return; }

  const client = new PlaneClient(cfg);
  const issue = await client.createIssue(projectId, body as {
    name: string;
    description_html?: string;
    priority?: string;
    label_ids?: string[];
    assignees?: string[];
  });

  cache.invalidate(`issues:${projectId}`);
  cache.invalidate('workspace-issues-all:');
  cache.invalidate('issue-counts:');
  broadcast({ type: 'refresh' });
  json(res, 201, { issue });
}

// ── Router ─────────────────────────────────────────────────────────────

const ISSUE_DETAIL_RE = /^\/issues\/([^/?]+)$/;
const ISSUE_COMMENTS_RE = /^\/issues\/([^/?]+)\/comments$/;
const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function router(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const params = qs(url);
  const pathname = url.split('?')[0];

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PATCH,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  try {
    if (pathname === '/health' && method === 'GET') {
      await handleHealth(res);
    } else if (pathname === '/me' && method === 'GET') {
      await handleMe(res);
    } else if (pathname === '/projects' && method === 'GET') {
      await handleProjects(res);
    } else if (pathname === '/states' && method === 'GET') {
      await handleStates(res, params);
    } else if (pathname === '/members' && method === 'GET') {
      await handleMembers(res, params);
    } else if (pathname === '/labels' && method === 'GET') {
      await handleLabels(res, params);
    } else if (pathname === '/cycles' && method === 'GET') {
      await handleCycles(res, params);
    } else if (pathname === '/issue-counts' && method === 'GET') {
      await handleIssueCounts(res);
    } else if (pathname === '/issues' && method === 'GET') {
      if (params.get('project')) {
        await handleIssueList(res, params);
      } else {
        await handleWorkspaceIssues(res, params);
      }
    } else if (pathname === '/issues' && method === 'POST') {
      await handleIssueCreate(req, res);
    } else {
      const mc = ISSUE_COMMENTS_RE.exec(pathname);
      if (mc && method === 'POST') {
        const issueId = mc[1];
        const projectId = params.get('project');
        if (!projectId) { json(res, 400, { error: 'project required' }); return; }
        if (!VALID_UUID.test(issueId) || !VALID_UUID.test(projectId)) {
          json(res, 400, { error: 'invalid id' }); return;
        }
        await handleCommentCreate(req, res, projectId, issueId);
        return;
      }
      const m = ISSUE_DETAIL_RE.exec(pathname);
      if (m) {
        const issueId = m[1];
        const projectId = params.get('project');
        if (!projectId) { json(res, 400, { error: 'project required' }); return; }
        if (!VALID_UUID.test(issueId) || !VALID_UUID.test(projectId)) {
          json(res, 400, { error: 'invalid id' }); return;
        }
        if (method === 'GET') {
          await handleIssueDetail(res, projectId, issueId);
        } else if (method === 'PATCH') {
          await handleIssueUpdate(req, res, projectId, issueId);
        } else {
          json(res, 405, { error: 'method not allowed' });
        }
      } else {
        json(res, 404, { error: 'not found' });
      }
    }
  } catch (err) {
    const raw = (err as Error).message ?? 'internal error';
    // Pass 4xx messages through (useful for config debugging); strip 5xx path details
    const is4xx = /^Plane API [45]\d\d/.test(raw) && raw.startsWith('Plane API 4');
    const msg = is4xx ? raw.replace(/:\s*\/.*$/, '') : 'upstream error';
    json(res, 502, { error: msg });
  }
}

// ── Server startup ─────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  void router(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  const allowed = [
    process.env['CLOUDCLI_ORIGIN'] ?? '',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ].filter(Boolean);

  if (origin && !allowed.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'connected' }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });
});

const PORT = parseInt(process.env.PORT ?? '0', 10);
server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});
