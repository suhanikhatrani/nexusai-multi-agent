# NexusAI — Multi-Agent System

A production-ready multi-agent AI system with real-time coordination, visual dashboards, and workflow automation.

## 📁 File Architecture

```
multi-agent-system/
├── backend/
│   ├── server.js          # Express + Socket.IO server, all API routes
│   ├── package.json       # Node dependencies
│   └── .env               # Environment variables (never commit this)
│
├── frontend/
│   └── index.html         # Single-file UI (no build step)
│
├── .gitignore
└── README.md
```

## 🧠 Agent Architecture

```
┌─────────────────────────────────────────────┐
│              Orchestrator Agent              │
│   Primary coordinator — routes, delegates    │
└────────┬──────┬──────┬──────┬───────────────┘
         │      │      │      │
    ┌────▼──┐ ┌─▼────┐ ┌▼───┐ ┌▼──────────┐
    │ Task  │ │ Cal. │ │Note│ │ Workflow  │
    │ Agent │ │Agent │ │Agt │ │  Agent    │
    └───────┘ └──────┘ └────┘ └───────────┘
```

## 🚀 Setup & Run

### 1. Configure environment

```bash
cd backend
cp .env .env.local   # edit .env.local with your real values
```

Required variables:
```
ANTHROPIC_API_KEY=sk-ant-...        # your Anthropic API key
ALLOWED_ORIGIN=http://localhost:3000 # frontend origin (use your deployed URL in production)
DATABASE_PATH=/data/nexusai.db      # optional: absolute path for hosted DB
PORT=3001                           # optional: defaults to 3001
```

### 2. Install & start

```bash
cd backend
npm install
node server.js
# Backend runs on http://localhost:3001
```

On first run, a bootstrap API key is printed to the console — **save it**, it won't be shown again.

### 3. Frontend

```bash
# Option 1: Open directly in browser
open frontend/index.html

# Option 2: Serve with any static server
npx serve frontend
# or
python3 -m http.server 3000 --directory frontend
```

> The frontend works standalone (mock data) without the backend. Connect the backend for real-time sync, Socket.IO events, and AI orchestration.

## 🔒 Production Security

| Feature | Details |
|---------|---------|
| API Key auth | All `/api/*` routes require `X-Api-Key` header |
| Key hashing | Keys stored as SHA-256 hashes — never in plaintext |
| CORS lockdown | Restricted to `ALLOWED_ORIGIN` env var |
| Rate limiting | 120 req/min general; 10 req/min on AI orchestrate route |
| Input validation | All POST/PUT bodies validated before DB write |
| Payload size cap | `express.json({ limit: '100kb' })` |
| Prompt length cap | Orchestrate prompts capped at 2000 chars |
| SQLite WAL mode | Crash-safe writes with `journal_mode = WAL` |
| Graceful shutdown | SIGTERM/SIGINT handlers close DB cleanly |
| Structured logging | JSON logs with level + timestamp (Railway/Render compatible) |
| Global error handlers | `uncaughtException` + `unhandledRejection` prevent silent crashes |

## 🌐 API Reference

All routes except `/health` require `X-Api-Key: <your-key>` header.

### Tasks
| Method | Endpoint | Body |
|--------|----------|------|
| GET | /api/tasks | — |
| POST | /api/tasks | `{ title*, status, priority, assignee, dueDate, tags }` |
| PUT | /api/tasks/:id | any task fields |
| DELETE | /api/tasks/:id | — |

### Events
| Method | Endpoint | Body |
|--------|----------|------|
| GET | /api/events | — |
| POST | /api/events | `{ title*, start*, end*, type, color }` |
| DELETE | /api/events/:id | — |

### Notes
| Method | Endpoint | Body |
|--------|----------|------|
| GET | /api/notes | — |
| POST | /api/notes | `{ title*, content, tags, pinned }` |
| PUT | /api/notes/:id | any note fields |
| DELETE | /api/notes/:id | — |

### Workflows
| Method | Endpoint | Body |
|--------|----------|------|
| GET | /api/workflows | — |
| POST | /api/workflows | `{ name*, steps*: [{name, agent}] }` |

### Orchestrator & Agents
| Method | Endpoint | Body |
|--------|----------|------|
| POST | /api/orchestrate | `{ prompt* }` (max 2000 chars) |
| GET | /api/agents | — |
| GET | /api/agents/logs | — |
| GET | /api/stats | — |

### MCP Tool Endpoints
| Method | Endpoint | Body |
|--------|----------|------|
| POST | /api/agents/tasks | `{ tool_name*, payload }` |
| POST | /api/agents/calendar | `{ tool_name*, payload }` |
| POST | /api/agents/notes | `{ tool_name*, payload }` |

`*` = required field

## 🌐 WebSocket Events

```
Server → Client:
  init              Initial state payload on connect
  tasks:update      Task list changed
  events:update     Event list changed
  notes:update      Notes list changed
  workflows:update  Workflow progress updated
  agents:update     Agent status changed
  agent:log         New activity log entry
  stats:update      System stats refreshed
```

## ☁️ Deploying to Railway / Render

1. Push to GitHub (`.env` and `nexusai.db` are gitignored)
2. Create a new service pointing to the `backend/` folder
3. Set environment variables in the dashboard:
   - `ANTHROPIC_API_KEY`
   - `ALLOWED_ORIGIN` → your frontend URL
   - `DATABASE_PATH` → `/data/nexusai.db` (use a persistent volume)
   - `PORT` → leave unset (Railway/Render inject this automatically)
4. Deploy — the bootstrap API key prints in the first-run logs

## ⚙️ Technology Stack

**Backend**: Node.js, Express, Socket.IO, better-sqlite3, UUID  
**Frontend**: Vanilla HTML/CSS/JS (no framework, no build step)  
**AI**: Anthropic Claude claude-sonnet-4-20250514 (via API)  
**Real-time**: Socket.IO WebSocket  
**Database**: SQLite (WAL mode)

## 🎨 Design System

- **Theme**: Dark — `#0a0b0f` base with layered surfaces
- **Accent**: Indigo `#6366f1` with purple secondary
- **Status colors**: Green (active/success), Amber (warning/pending), Pink (notes), Purple (workflow)
- **Typography**: DM Sans 300–600 + JetBrains Mono for code/labels
- **Responsive**: 3 breakpoints — desktop (1000px+), tablet (600–900px), mobile (<600px)

## MCP Tool Simulation

This project implements the **Model Context Protocol (MCP)** tool interface pattern.

| Agent | Endpoint | Tools |
|-------|----------|-------|
| `task-agent` | `/api/agents/tasks` | `create_task`, `list_tasks`, `update_task`, `delete_task` |
| `calendar-agent` | `/api/agents/calendar` | `schedule_event`, `list_events`, `cancel_event` |
| `notes-agent` | `/api/agents/notes` | `create_note`, `list_notes`, `update_note`, `delete_note` |

Each agent receives `{ tool_name, payload }` and returns a structured result — swappable for real MCP servers without changing orchestrator logic.
