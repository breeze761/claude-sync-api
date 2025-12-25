const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const dataDir = process.env.DATA_PATH || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const projectsFile = path.join(dataDir, 'projects.json');
const historyFile = path.join(dataDir, 'history.json');

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getProjects() { return loadJSON(projectsFile); }
function saveProjects(data) { saveJSON(projectsFile, data); }
function getHistory() { return loadJSON(historyFile); }
function saveHistory(data) { saveJSON(historyFile, data); }

const API_KEY = process.env.CLAUDE_SYNC_KEY;
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const queryKey = req.query.key;
  const token = authHeader?.replace('Bearer ', '') || queryKey;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
  if (token !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/sync', authenticate, (req, res) => {
  const projects = getProjects();
  const list = Object.entries(projects).map(([name, data]) => ({
    project: name,
    summary: data.summary,
    updated_at: data.updated_at
  })).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  res.json({ projects: list });
});

app.get('/sync/:project', authenticate, (req, res) => {
  const { project } = req.params;
  const includeFiles = req.query.include_files === 'true';
  const includeHistory = parseInt(req.query.include_history) || 0;

  const projects = getProjects();
  const data = projects[project];
  if (!data) return res.status(404).json({ error: 'Project not found' });

  const response = {
    project,
    summary: data.summary,
    claude_md: data.claude_md,
    updated_at: data.updated_at,
    metadata: data.metadata
  };

  if (includeFiles && data.files) response.files = data.files;

  if (includeHistory > 0) {
    const history = getHistory();
    const projectHistory = (history[project] || [])
      .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
      .slice(0, includeHistory);
    response.history = projectHistory;
  }

  res.json(response);
});

app.post('/sync/:project', authenticate, (req, res) => {
  const { project } = req.params;
  const { claude_md, summary, files, metadata } = req.body;
  const now = new Date().toISOString();

  const projects = getProjects();
  const existing = projects[project] || {};

  projects[project] = {
    claude_md: claude_md || existing.claude_md,
    summary: summary || existing.summary,
    files: files || existing.files,
    metadata: metadata || existing.metadata,
    updated_at: now
  };
  saveProjects(projects);

  if (summary) {
    const history = getHistory();
    if (!history[project]) history[project] = [];
    history[project].push({
      summary,
      claude_md,
      files,
      metadata,
      synced_at: now
    });
    if (history[project].length > 50) {
      history[project] = history[project].slice(-50);
    }
    saveHistory(history);
  }

  res.json({ success: true, project, updated_at: now });
});

app.get('/sync/:project/history', authenticate, (req, res) => {
  const { project } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const history = getHistory();
  const projectHistory = (history[project] || [])
    .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
    .slice(0, limit);
  res.json({ project, history: projectHistory });
});

app.delete('/sync/:project', authenticate, (req, res) => {
  const { project } = req.params;
  const projects = getProjects();
  delete projects[project];
  saveProjects(projects);

  const history = getHistory();
  delete history[project];
  saveHistory(history);

  res.json({ success: true, deleted: project });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Claude Sync API running on port ${PORT}`));
