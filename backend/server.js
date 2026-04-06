require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// ─── Structured Logger ────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log(JSON.stringify({ level: 'info',  ts: new Date().toISOString(), msg: a.join(' ') })),
  warn:  (...a) => console.log(JSON.stringify({ level: 'warn',  ts: new Date().toISOString(), msg: a.join(' ') })),
  error: (...a) => console.error(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg: a.join(' ') })),
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000' }
});

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000' }));
app.use(express.json({ limit: '100kb' }));  // prevent oversized payloads

// ─── Rate Limiter (no extra deps) ─────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxReqs, windowMs) {
  return (req, res, next) => {
    if (req.path === '/health') return next();
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
    entry.count++;
    rateLimitMap.set(ip, entry);
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests — slow down' });
    }
    next();
  };
}
// Clean up stale IPs every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, e] of rateLimitMap) if (e.start < cutoff) rateLimitMap.delete(ip);
}, 300_000);

app.use(rateLimit(120, 60_000));              // 120 req/min general
const orchestrateLimit = rateLimit(10, 60_000); // 10 req/min for AI route

// ─── SQLite Setup ─────────────────────────────────────────────────────────────
const sqlite = new Database(process.env.DATABASE_PATH || path.join(__dirname, 'nexusai.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS tasks     (id TEXT PRIMARY KEY, data TEXT);
  CREATE TABLE IF NOT EXISTS events    (id TEXT PRIMARY KEY, data TEXT);
  CREATE TABLE IF NOT EXISTS notes     (id TEXT PRIMARY KEY, data TEXT);
  CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, data TEXT);
  CREATE TABLE IF NOT EXISTS api_keys (
    id         TEXT PRIMARY KEY,
    key_hash   TEXT UNIQUE NOT NULL,
    label      TEXT,
    created_at TEXT
  );
`);

// ─── API Key Auth ─────────────────────────────────────────────────────────────
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const keyCount = sqlite.prepare('SELECT COUNT(*) as c FROM api_keys').get();
if (keyCount.c === 0) {
  const bootstrapKey = `nexus-${uuidv4().replace(/-/g, '')}`;
  sqlite.prepare('INSERT INTO api_keys VALUES (?,?,?,?)').run(
    uuidv4(), hashKey(bootstrapKey), 'default', new Date().toISOString()
  );
  log.info('╔══════════════════════════════════════════════════════════╗');
  log.info('║  NexusAI API Key (save this — shown once!)               ║');
  log.info(`║  ${bootstrapKey}  ║`);
  log.info('╚══════════════════════════════════════════════════════════╝');
}

function requireApiKey(req, res, next) {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'Missing X-Api-Key header' });
  const row = sqlite.prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hashKey(key));
  if (!row) return res.status(403).json({ error: 'Invalid API key' });
  next();
}
app.use('/api', requireApiKey);

// ─── Input Validators ─────────────────────────────────────────────────────────
function validateTask(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim())
    return 'title is required and must be a string';
  const allowedStatus = ['todo', 'in-progress', 'review', 'done'];
  if (body.status && !allowedStatus.includes(body.status))
    return `status must be one of: ${allowedStatus.join(', ')}`;
  const allowedPriority = ['low', 'medium', 'high'];
  if (body.priority && !allowedPriority.includes(body.priority))
    return `priority must be one of: ${allowedPriority.join(', ')}`;
  return null;
}

function validateEvent(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim())
    return 'title is required and must be a string';
  if (!body.start || isNaN(Date.parse(body.start)))
    return 'start must be a valid ISO date string';
  if (!body.end || isNaN(Date.parse(body.end)))
    return 'end must be a valid ISO date string';
  return null;
}

function validateNote(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim())
    return 'title is required and must be a string';
  return null;
}

function validateWorkflow(body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim())
    return 'name is required and must be a string';
  if (!Array.isArray(body.steps) || body.steps.length === 0)
    return 'steps must be a non-empty array';
  for (const s of body.steps) {
    if (!s.name || typeof s.name !== 'string') return 'each step must have a name string';
    if (!s.agent || typeof s.agent !== 'string') return 'each step must have an agent string';
  }
  return null;
}

// ─── SQLite Helpers ───────────────────────────────────────────────────────────
function getAll(table) {
  return sqlite.prepare(`SELECT data FROM ${table}`).all().map(r => JSON.parse(r.data));
}
function getOne(table, id) {
  const row = sqlite.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
  return row ? JSON.parse(row.data) : null;
}
function upsert(table, id, obj) {
  sqlite.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`).run(id, JSON.stringify(obj));
  return obj;
}
function remove(table, id) {
  sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
if (sqlite.prepare('SELECT COUNT(*) as c FROM tasks').get().c === 0) {
  for (const t of [
    { id: uuidv4(), title: 'Setup CI/CD pipeline',        status: 'in-progress', priority: 'high',   assignee: 'Orchestrator', dueDate: '2026-04-10', tags: ['devops'],  agentId: 'task-agent', createdAt: new Date().toISOString() },
    { id: uuidv4(), title: 'Write API documentation',     status: 'todo',        priority: 'medium', assignee: 'Docs Agent',   dueDate: '2026-04-15', tags: ['docs'],    agentId: 'task-agent', createdAt: new Date().toISOString() },
    { id: uuidv4(), title: 'Code review for auth module', status: 'review',      priority: 'high',   assignee: 'Review Agent', dueDate: '2026-04-08', tags: ['code'],    agentId: 'task-agent', createdAt: new Date().toISOString() },
    { id: uuidv4(), title: 'Deploy to staging',           status: 'done',        priority: 'low',    assignee: 'Deploy Agent', dueDate: '2026-04-05', tags: ['deploy'],  agentId: 'task-agent', createdAt: new Date().toISOString() },
  ]) upsert('tasks', t.id, t);
}

if (sqlite.prepare('SELECT COUNT(*) as c FROM events').get().c === 0) {
  for (const e of [
    { id: uuidv4(), title: 'Sprint Planning',   start: '2026-04-07T09:00:00', end: '2026-04-07T11:00:00', type: 'meeting', color: '#6366f1', agentId: 'calendar-agent' },
    { id: uuidv4(), title: 'Agent Sync',        start: '2026-04-09T14:00:00', end: '2026-04-09T15:00:00', type: 'sync',    color: '#10b981', agentId: 'calendar-agent' },
    { id: uuidv4(), title: 'Deployment Window', start: '2026-04-11T18:00:00', end: '2026-04-11T20:00:00', type: 'deploy',  color: '#f59e0b', agentId: 'calendar-agent' },
  ]) upsert('events', e.id, e);
}

if (sqlite.prepare('SELECT COUNT(*) as c FROM notes').get().c === 0) {
  for (const n of [
    { id: uuidv4(), title: 'Architecture Notes',     content: '## System Architecture\n\nThe multi-agent system uses an **orchestrator** pattern.\n\n- Calendar Agent: manages scheduling\n- Task Agent: tracks work items\n- Notes Agent: organizes knowledge\n- Workflow Agent: executes pipelines', tags: ['architecture'], agentId: 'notes-agent', pinned: true,  createdAt: new Date().toISOString() },
    { id: uuidv4(), title: 'API Design Decisions',   content: '## REST API Guidelines\n\nAll endpoints follow RESTful conventions.\n\n```\nGET /api/tasks\nPOST /api/tasks\nPUT /api/tasks/:id\nDELETE /api/tasks/:id\n```', tags: ['api', 'docs'], agentId: 'notes-agent', pinned: false, createdAt: new Date().toISOString() },
    { id: uuidv4(), title: 'Agent Coordination Log', content: '## Coordination Events\n\n**2026-04-06**: Orchestrator dispatched 3 sub-agents for sprint kickoff.\n\n**Tasks Created**: 12\n**Events Scheduled**: 4', tags: ['logs'], agentId: 'notes-agent', pinned: false, createdAt: new Date().toISOString() },
  ]) upsert('notes', n.id, n);
}

if (sqlite.prepare('SELECT COUNT(*) as c FROM workflows').get().c === 0) {
  const w = {
    id: uuidv4(), name: 'Sprint Kickoff', status: 'completed', progress: 100,
    steps: [
      { id: 's1', name: 'Create sprint tasks', agent: 'task-agent',     status: 'done', duration: 1200 },
      { id: 's2', name: 'Schedule meetings',   agent: 'calendar-agent', status: 'done', duration: 800  },
      { id: 's3', name: 'Generate docs',       agent: 'notes-agent',    status: 'done', duration: 1500 },
      { id: 's4', name: 'Notify team',         agent: 'orchestrator',   status: 'done', duration: 400  },
    ],
    createdAt: new Date(Date.now() - 3600000).toISOString()
  };
  upsert('workflows', w.id, w);
}

// ─── In-memory agents + logs (ephemeral by design) ────────────────────────────
const agents = [
  { id: 'orchestrator',   name: 'Orchestrator',   role: 'Primary',     status: 'active', tasksCompleted: 47,  color: '#6366f1' },
  { id: 'task-agent',     name: 'Task Agent',     role: 'Specialized', status: 'active', tasksCompleted: 128, color: '#10b981' },
  { id: 'calendar-agent', name: 'Calendar Agent', role: 'Specialized', status: 'active', tasksCompleted: 34,  color: '#f59e0b' },
  { id: 'notes-agent',    name: 'Notes Agent',    role: 'Specialized', status: 'idle',   tasksCompleted: 21,  color: '#ec4899' },
  { id: 'workflow-agent', name: 'Workflow Agent', role: 'Specialized', status: 'active', tasksCompleted: 15,  color: '#8b5cf6' },
];
const agentLogs = [];

function emitLog(agent, action, detail, type = 'info') {
  const entry = { id: uuidv4(), agent, action, detail, type, ts: new Date().toISOString() };
  agentLogs.unshift(entry);
  if (agentLogs.length > 100) agentLogs.pop();
  io.emit('agent:log', entry);
  return entry;
}

function emitStats() {
  io.emit('stats:update', {
    tasks: getAll('tasks').length, events: getAll('events').length,
    notes: getAll('notes').length, workflows: getAll('workflows').length,
    agents: agents.filter(a => a.status === 'active').length,
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ─── API Key Management ───────────────────────────────────────────────────────
app.post('/api/keys', (req, res) => {
  try {
    const newKey = `nexus-${uuidv4().replace(/-/g, '')}`;
    sqlite.prepare('INSERT INTO api_keys VALUES (?,?,?,?)').run(
      uuidv4(), hashKey(newKey), req.body?.label || 'unnamed', new Date().toISOString()
    );
    res.json({ key: newKey, note: 'Save this — it will not be shown again.' });
  } catch (err) {
    log.error('POST /api/keys', err.message);
    res.status(500).json({ error: 'Failed to create key' });
  }
});

app.get('/api/keys', (req, res) => {
  try {
    res.json(sqlite.prepare('SELECT id, label, created_at FROM api_keys').all());
  } catch (err) {
    log.error('GET /api/keys', err.message);
    res.status(500).json({ error: 'Failed to list keys' });
  }
});

app.delete('/api/keys/:id', (req, res) => {
  try {
    if (sqlite.prepare('SELECT COUNT(*) as c FROM api_keys').get().c <= 1)
      return res.status(400).json({ error: 'Cannot delete the last key' });
    sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    log.error('DELETE /api/keys', err.message);
    res.status(500).json({ error: 'Failed to delete key' });
  }
});

// ─── Tasks API ────────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  try { res.json(getAll('tasks')); }
  catch (err) { log.error('GET /api/tasks', err.message); res.status(500).json({ error: 'Failed to fetch tasks' }); }
});

app.post('/api/tasks', (req, res) => {
  try {
    const ve = validateTask(req.body);
    if (ve) return res.status(400).json({ error: ve });
    const task = { id: uuidv4(), ...req.body, agentId: 'task-agent', createdAt: new Date().toISOString() };
    upsert('tasks', task.id, task);
    emitLog('task-agent', 'CREATE_TASK', `Created task: ${task.title}`, 'success');
    io.emit('tasks:update', getAll('tasks')); emitStats();
    res.status(201).json(task);
  } catch (err) { log.error('POST /api/tasks', err.message); res.status(500).json({ error: 'Failed to create task' }); }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const existing = getOne('tasks', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    const ve = validateTask({ ...existing, ...req.body });
    if (ve) return res.status(400).json({ error: ve });
    const updated = { ...existing, ...req.body };
    upsert('tasks', updated.id, updated);
    emitLog('task-agent', 'UPDATE_TASK', `Updated task: ${updated.title}`, 'info');
    io.emit('tasks:update', getAll('tasks'));
    res.json(updated);
  } catch (err) { log.error('PUT /api/tasks/:id', err.message); res.status(500).json({ error: 'Failed to update task' }); }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const existing = getOne('tasks', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    remove('tasks', req.params.id);
    emitLog('task-agent', 'DELETE_TASK', `Deleted task: ${existing.title}`, 'warning');
    io.emit('tasks:update', getAll('tasks')); emitStats();
    res.json({ ok: true });
  } catch (err) { log.error('DELETE /api/tasks/:id', err.message); res.status(500).json({ error: 'Failed to delete task' }); }
});

// ─── Events API ───────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  try { res.json(getAll('events')); }
  catch (err) { log.error('GET /api/events', err.message); res.status(500).json({ error: 'Failed to fetch events' }); }
});

app.post('/api/events', (req, res) => {
  try {
    const ve = validateEvent(req.body);
    if (ve) return res.status(400).json({ error: ve });
    const event = { id: uuidv4(), ...req.body, agentId: 'calendar-agent' };
    upsert('events', event.id, event);
    emitLog('calendar-agent', 'SCHEDULE_EVENT', `Scheduled: ${event.title}`, 'success');
    io.emit('events:update', getAll('events')); emitStats();
    res.status(201).json(event);
  } catch (err) { log.error('POST /api/events', err.message); res.status(500).json({ error: 'Failed to create event' }); }
});

app.delete('/api/events/:id', (req, res) => {
  try {
    const existing = getOne('events', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });
    remove('events', req.params.id);
    emitLog('calendar-agent', 'DELETE_EVENT', `Cancelled: ${existing.title}`, 'warning');
    io.emit('events:update', getAll('events')); emitStats();
    res.json({ ok: true });
  } catch (err) { log.error('DELETE /api/events/:id', err.message); res.status(500).json({ error: 'Failed to delete event' }); }
});

// ─── Notes API ────────────────────────────────────────────────────────────────
app.get('/api/notes', (req, res) => {
  try { res.json(getAll('notes')); }
  catch (err) { log.error('GET /api/notes', err.message); res.status(500).json({ error: 'Failed to fetch notes' }); }
});

app.post('/api/notes', (req, res) => {
  try {
    const ve = validateNote(req.body);
    if (ve) return res.status(400).json({ error: ve });
    const note = { id: uuidv4(), ...req.body, agentId: 'notes-agent', createdAt: new Date().toISOString() };
    upsert('notes', note.id, note);
    emitLog('notes-agent', 'CREATE_NOTE', `Created note: ${note.title}`, 'success');
    io.emit('notes:update', getAll('notes')); emitStats();
    res.status(201).json(note);
  } catch (err) { log.error('POST /api/notes', err.message); res.status(500).json({ error: 'Failed to create note' }); }
});

app.put('/api/notes/:id', (req, res) => {
  try {
    const existing = getOne('notes', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Note not found' });
    const updated = { ...existing, ...req.body };
    upsert('notes', updated.id, updated);
    emitLog('notes-agent', 'UPDATE_NOTE', `Updated note: ${updated.title}`, 'info');
    io.emit('notes:update', getAll('notes'));
    res.json(updated);
  } catch (err) { log.error('PUT /api/notes/:id', err.message); res.status(500).json({ error: 'Failed to update note' }); }
});

app.delete('/api/notes/:id', (req, res) => {
  try {
    const existing = getOne('notes', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Note not found' });
    remove('notes', req.params.id);
    emitLog('notes-agent', 'DELETE_NOTE', `Deleted note: ${existing.title}`, 'warning');
    io.emit('notes:update', getAll('notes')); emitStats();
    res.json({ ok: true });
  } catch (err) { log.error('DELETE /api/notes/:id', err.message); res.status(500).json({ error: 'Failed to delete note' }); }
});

// ─── Workflows API ────────────────────────────────────────────────────────────
app.get('/api/workflows', (req, res) => {
  try { res.json(getAll('workflows')); }
  catch (err) { log.error('GET /api/workflows', err.message); res.status(500).json({ error: 'Failed to fetch workflows' }); }
});

app.post('/api/workflows', (req, res) => {
  try {
    const ve = validateWorkflow(req.body);
    if (ve) return res.status(400).json({ error: ve });
    const wf = {
      id: uuidv4(), name: req.body.name, status: 'pending', progress: 0,
      steps: req.body.steps.map((s, i) => ({ id: `s${i+1}`, ...s, status: 'pending', duration: null })),
      createdAt: new Date().toISOString()
    };
    upsert('workflows', wf.id, wf);
    emitLog('orchestrator', 'WORKFLOW_CREATED', `Workflow "${wf.name}" queued`, 'info');
    io.emit('workflows:update', getAll('workflows'));
    setTimeout(() => simulateWorkflow(wf.id), 1000);
    res.status(201).json(wf);
  } catch (err) { log.error('POST /api/workflows', err.message); res.status(500).json({ error: 'Failed to create workflow' }); }
});

function simulateWorkflow(wfId) {
  try {
    const wf = getOne('workflows', wfId);
    if (!wf) return;
    wf.status = 'running';
    upsert('workflows', wf.id, wf);
    io.emit('workflows:update', getAll('workflows'));
    emitLog('orchestrator', 'WORKFLOW_STARTED', `Executing "${wf.name}"`, 'info');

    let stepIdx = 0;
    const runStep = () => {
      try {
        const fresh = getOne('workflows', wfId);
        if (!fresh) return;
        if (stepIdx >= fresh.steps.length) {
          fresh.status = 'completed'; fresh.progress = 100;
          upsert('workflows', fresh.id, fresh);
          io.emit('workflows:update', getAll('workflows'));
          emitLog('orchestrator', 'WORKFLOW_DONE', `"${fresh.name}" completed`, 'success');
          emitStats(); return;
        }
        const step = fresh.steps[stepIdx];
        step.status = 'running';
        const agent = agents.find(a => a.id === step.agent);
        if (agent) agent.status = 'active';
        upsert('workflows', fresh.id, fresh);
        io.emit('workflows:update', getAll('workflows'));
        io.emit('agents:update', agents);
        emitLog(step.agent, 'STEP_RUNNING', `Executing: ${step.name}`, 'info');

        const duration = 1000 + Math.random() * 2000;
        setTimeout(() => {
          try {
            const wf2 = getOne('workflows', wfId);
            if (!wf2) return;
            wf2.steps[stepIdx].status = 'done';
            wf2.steps[stepIdx].duration = Math.round(duration);
            stepIdx++;
            wf2.progress = Math.round((stepIdx / wf2.steps.length) * 100);
            upsert('workflows', wf2.id, wf2);
            io.emit('workflows:update', getAll('workflows'));
            emitLog(step.agent, 'STEP_DONE', `Completed: ${step.name}`, 'success');
            runStep();
          } catch (err) { log.error('simulateWorkflow step callback', err.message); }
        }, duration);
      } catch (err) { log.error('simulateWorkflow runStep', err.message); }
    };
    runStep();
  } catch (err) { log.error('simulateWorkflow', err.message); }
}

// ─── Agents API ───────────────────────────────────────────────────────────────
app.get('/api/agents', (req, res) => res.json(agents));
app.get('/api/agents/logs', (req, res) => res.json(agentLogs.slice(0, 50)));

// ─── MCP-Compatible Agent Tool Endpoints ─────────────────────────────────────
app.post('/api/agents/tasks', (req, res) => {
  try {
    const { tool_name, payload } = req.body || {};
    if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });
    if (tool_name === 'create_task') {
      const ve = validateTask(payload); if (ve) return res.status(400).json({ error: ve });
      const task = { id: uuidv4(), ...payload, agentId: 'task-agent', createdAt: new Date().toISOString() };
      upsert('tasks', task.id, task);
      emitLog('task-agent', 'MCP_CREATE_TASK', `MCP created: ${task.title}`, 'success');
      io.emit('tasks:update', getAll('tasks')); emitStats();
      return res.status(201).json({ ok: true, result: task });
    }
    if (tool_name === 'list_tasks') return res.json({ ok: true, result: getAll('tasks') });
    if (tool_name === 'update_task') {
      if (!payload?.id) return res.status(400).json({ error: 'payload.id is required' });
      const existing = getOne('tasks', payload.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const updated = { ...existing, ...payload };
      upsert('tasks', updated.id, updated);
      emitLog('task-agent', 'MCP_UPDATE_TASK', `MCP updated: ${updated.title}`, 'info');
      io.emit('tasks:update', getAll('tasks'));
      return res.json({ ok: true, result: updated });
    }
    if (tool_name === 'delete_task') {
      if (!payload?.id) return res.status(400).json({ error: 'payload.id is required' });
      const existing = getOne('tasks', payload.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      remove('tasks', payload.id);
      emitLog('task-agent', 'MCP_DELETE_TASK', `MCP deleted: ${existing.title}`, 'warning');
      io.emit('tasks:update', getAll('tasks')); emitStats();
      return res.json({ ok: true });
    }
    res.status(400).json({ error: `Unknown tool: ${tool_name}` });
  } catch (err) { log.error('POST /api/agents/tasks', err.message); res.status(500).json({ error: 'Agent tool call failed' }); }
});

app.post('/api/agents/calendar', (req, res) => {
  try {
    const { tool_name, payload } = req.body || {};
    if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });
    if (tool_name === 'schedule_event') {
      const ve = validateEvent(payload); if (ve) return res.status(400).json({ error: ve });
      const event = { id: uuidv4(), ...payload, agentId: 'calendar-agent' };
      upsert('events', event.id, event);
      emitLog('calendar-agent', 'MCP_SCHEDULE', `MCP scheduled: ${event.title}`, 'success');
      io.emit('events:update', getAll('events')); emitStats();
      return res.status(201).json({ ok: true, result: event });
    }
    if (tool_name === 'list_events') return res.json({ ok: true, result: getAll('events') });
    if (tool_name === 'cancel_event') {
      if (!payload?.id) return res.status(400).json({ error: 'payload.id is required' });
      const existing = getOne('events', payload.id);
      if (!existing) return res.status(404).json({ error: 'Event not found' });
      remove('events', payload.id);
      emitLog('calendar-agent', 'MCP_CANCEL', `MCP cancelled: ${existing.title}`, 'warning');
      io.emit('events:update', getAll('events')); emitStats();
      return res.json({ ok: true });
    }
    res.status(400).json({ error: `Unknown tool: ${tool_name}` });
  } catch (err) { log.error('POST /api/agents/calendar', err.message); res.status(500).json({ error: 'Agent tool call failed' }); }
});

app.post('/api/agents/notes', (req, res) => {
  try {
    const { tool_name, payload } = req.body || {};
    if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });
    if (tool_name === 'create_note') {
      const ve = validateNote(payload); if (ve) return res.status(400).json({ error: ve });
      const note = { id: uuidv4(), ...payload, agentId: 'notes-agent', createdAt: new Date().toISOString() };
      upsert('notes', note.id, note);
      emitLog('notes-agent', 'MCP_CREATE_NOTE', `MCP note: ${note.title}`, 'success');
      io.emit('notes:update', getAll('notes')); emitStats();
      return res.status(201).json({ ok: true, result: note });
    }
    if (tool_name === 'list_notes') return res.json({ ok: true, result: getAll('notes') });
    if (tool_name === 'update_note') {
      if (!payload?.id) return res.status(400).json({ error: 'payload.id is required' });
      const existing = getOne('notes', payload.id);
      if (!existing) return res.status(404).json({ error: 'Note not found' });
      const updated = { ...existing, ...payload };
      upsert('notes', updated.id, updated);
      emitLog('notes-agent', 'MCP_UPDATE_NOTE', `MCP updated: ${updated.title}`, 'info');
      io.emit('notes:update', getAll('notes'));
      return res.json({ ok: true, result: updated });
    }
    if (tool_name === 'delete_note') {
      if (!payload?.id) return res.status(400).json({ error: 'payload.id is required' });
      const existing = getOne('notes', payload.id);
      if (!existing) return res.status(404).json({ error: 'Note not found' });
      remove('notes', payload.id);
      emitLog('notes-agent', 'MCP_DELETE_NOTE', `MCP deleted: ${existing.title}`, 'warning');
      io.emit('notes:update', getAll('notes')); emitStats();
      return res.json({ ok: true });
    }
    res.status(400).json({ error: `Unknown tool: ${tool_name}` });
  } catch (err) { log.error('POST /api/agents/notes', err.message); res.status(500).json({ error: 'Agent tool call failed' }); }
});

// ─── Orchestrator ─────────────────────────────────────────────────────────────
app.post('/api/orchestrate', orchestrateLimit, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || !prompt.trim())
    return res.status(400).json({ error: 'prompt is required and must be a non-empty string' });
  if (prompt.length > 2000)
    return res.status(400).json({ error: 'prompt must be 2000 characters or fewer' });

  emitLog('orchestrator', 'ORCHESTRATE', `Processing: "${prompt.substring(0, 80)}"`, 'info');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are an AI orchestrator coordinating a multi-agent system with: task-agent, calendar-agent, notes-agent, workflow-agent.
Given a user prompt, respond ONLY with valid JSON (no markdown fences) of this shape:
{
  "intent": "string describing what the user wants",
  "agents": ["agent-ids-to-involve"],
  "actions": [
    {"agent":"agent-id","tool":"create_task|schedule_event|create_note|run_workflow","payload":{}}
  ],
  "summary": "human-readable summary of what was done"
}
For run_workflow, payload must be: { "name": "string", "steps": [{"name":"string","agent":"agent-id"}] }`,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error('Anthropic API error', response.status, errText);
      return res.status(502).json({ error: 'AI service unavailable — try again shortly' });
    }

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';
    let plan;
    try { plan = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { plan = { intent: prompt, agents: ['orchestrator'], actions: [], summary: text }; }

    const results = [];
    for (const action of (plan.actions || [])) {
      try {
        if (action.tool === 'create_task') {
          const t = { id: uuidv4(), ...action.payload, agentId: 'task-agent', status: action.payload?.status || 'todo', createdAt: new Date().toISOString() };
          upsert('tasks', t.id, t);
          emitLog('task-agent', 'AI_CREATE_TASK', `AI created: ${t.title}`, 'success');
          io.emit('tasks:update', getAll('tasks'));
          results.push({ type: 'task', data: t });
        } else if (action.tool === 'schedule_event') {
          const e = { id: uuidv4(), ...action.payload, agentId: 'calendar-agent' };
          upsert('events', e.id, e);
          emitLog('calendar-agent', 'AI_SCHEDULE', `AI scheduled: ${e.title}`, 'success');
          io.emit('events:update', getAll('events'));
          results.push({ type: 'event', data: e });
        } else if (action.tool === 'create_note') {
          const n = { id: uuidv4(), ...action.payload, agentId: 'notes-agent', createdAt: new Date().toISOString() };
          upsert('notes', n.id, n);
          emitLog('notes-agent', 'AI_CREATE_NOTE', `AI created note: ${n.title}`, 'success');
          io.emit('notes:update', getAll('notes'));
          results.push({ type: 'note', data: n });
        } else if (action.tool === 'run_workflow') {
          const wf = {
            id: uuidv4(), name: action.payload?.name || 'AI Workflow', status: 'pending', progress: 0,
            steps: (action.payload?.steps || []).map((s, i) => ({ id: `s${i+1}`, ...s, status: 'pending', duration: null })),
            createdAt: new Date().toISOString()
          };
          upsert('workflows', wf.id, wf);
          emitLog('workflow-agent', 'AI_RUN_WORKFLOW', `AI triggered: "${wf.name}"`, 'info');
          io.emit('workflows:update', getAll('workflows'));
          setTimeout(() => simulateWorkflow(wf.id), 500);
          results.push({ type: 'workflow', data: wf });
        }
      } catch (actionErr) { log.error('orchestrate action failed', action.tool, actionErr.message); }
    }
    emitStats();
    res.json({ plan, results });
  } catch (err) {
    log.error('POST /api/orchestrate', err.message);
    res.status(500).json({ error: 'Orchestration failed — please try again' });
  }
});

// ─── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const tasks = getAll('tasks');
    res.json({
      tasks: tasks.length, events: getAll('events').length,
      notes: getAll('notes').length, workflows: getAll('workflows').length,
      agents: agents.filter(a => a.status === 'active').length,
      tasksByStatus: {
        todo:          tasks.filter(t => t.status === 'todo').length,
        'in-progress': tasks.filter(t => t.status === 'in-progress').length,
        review:        tasks.filter(t => t.status === 'review').length,
        done:          tasks.filter(t => t.status === 'done').length,
      }
    });
  } catch (err) { log.error('GET /api/stats', err.message); res.status(500).json({ error: 'Failed to fetch stats' }); }
});

// ─── 404 Catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('Unhandled express error', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  log.info('Client connected', socket.id);
  socket.emit('init', {
    tasks: getAll('tasks'), events: getAll('events'),
    notes: getAll('notes'), workflows: getAll('workflows'), agents
  });
  socket.on('disconnect', () => log.info('Client disconnected', socket.id));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => log.info(`NexusAI Multi-Agent Backend running on port ${PORT}`));

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    log.info('HTTP server closed');
    sqlite.close();
    log.info('Database closed');
    process.exit(0);
  });
  setTimeout(() => { log.error('Forced exit after timeout'); process.exit(1); }, 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', String(reason));
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err.message);
  process.exit(1);
});
