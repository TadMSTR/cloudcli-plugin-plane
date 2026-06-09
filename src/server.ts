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
const VERSION = '0.1.0';

// ── Config loading ─────────────────────────────────────────────────────

function loadConfig(): PluginConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as Partial<PluginConfig>;
    if (!cfg.planeUrl || !cfg.apiKey || !cfg.workspaceSlug) return null;
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

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
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

  const cacheKey = `cycles:${project}`;
  let cycles = cache.get<PlaneCycle[]>(cacheKey);
  if (!cycles) {
    const client = new PlaneClient(cfg);
    cycles = await client.listCycles(project);
    cache.set(cacheKey, cycles, TTL_CYCLES);
  }
  json(res, 200, { cycles });
}

async function handleIssueList(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) { json(res, 503, { error: 'not configured' }); return; }
  const project = params.get('project');
  if (!project) { json(res, 400, { error: 'project required' }); return; }

  const filters = {
    state_group: params.get('state_group') ?? undefined,
    priority:    params.get('priority')    ?? undefined,
    assignee:    params.get('assignee')    ?? undefined,
    label:       params.get('label')       ?? undefined,
  };
  const cycleId = params.get('cycle');

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

  const client = new PlaneClient(cfg);
  const issue = await client.createIssue(projectId, body as {
    name: string;
    description_html?: string;
    priority?: string;
    label_ids?: string[];
    assignees?: string[];
  });

  cache.invalidate(`issues:${projectId}`);
  broadcast({ type: 'refresh' });
  json(res, 201, { issue });
}

// ── Router ─────────────────────────────────────────────────────────────

const ISSUE_DETAIL_RE = /^\/issues\/([^/?]+)$/;

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
    } else if (pathname === '/issues' && method === 'GET') {
      await handleIssueList(res, params);
    } else if (pathname === '/issues' && method === 'POST') {
      await handleIssueCreate(req, res);
    } else {
      const m = ISSUE_DETAIL_RE.exec(pathname);
      if (m) {
        const issueId = m[1];
        const projectId = params.get('project');
        if (!projectId) { json(res, 400, { error: 'project required' }); return; }
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
    const msg = (err as Error).message ?? 'internal error';
    json(res, 502, { error: msg });
  }
}

// ── Server startup ─────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  void router(req, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/upgrade') {
    wss.handleUpgrade(req, socket, head, ws => {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: 'connected' }));
      ws.on('close', () => wsClients.delete(ws));
      ws.on('error', () => wsClients.delete(ws));
    });
  } else {
    socket.destroy();
  }
});

const PORT = parseInt(process.env.PORT ?? '0', 10);
server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});
