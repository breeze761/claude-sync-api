const path = require('path');
const fs = require('fs');

// Use /tmp for Vercel serverless (writable directory)
const dataDir = '/tmp';
const projectsFile = path.join(dataDir, 'projects.json');
const historyFile = path.join(dataDir, 'history.json');

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading JSON:', e);
  }
  return {};
}

function saveJSON(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving JSON:', e);
  }
}

const API_KEY = process.env.CLAUDE_SYNC_KEY;

function authenticate(req) {
  const authHeader = req.headers.authorization;
  // Try multiple ways to get the key (Vercel passes query params differently)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryKey = url.searchParams.get('key') || (req.query && req.query.key);
  const token = authHeader?.replace('Bearer ', '') || queryKey;

  // Debug: log what we're seeing
  console.log('Auth debug:', {
    url: req.url,
    queryKey,
    hasApiKey: !!API_KEY,
    apiKeyLength: API_KEY?.length,
    tokenLength: token?.length
  });

  if (!API_KEY) return { error: 'API key not configured', status: 500, debug: { url: req.url, hasQuery: !!req.query } };
  if (token !== API_KEY) return {
    error: 'Unauthorized',
    status: 401,
    debug: {
      tokenLen: token?.length,
      apiKeyLen: API_KEY?.length,
      match: token === API_KEY,
      tokenTrimmed: token?.trim() === API_KEY?.trim()
    }
  };
  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check - no auth required
  if (pathname === '/api' || pathname === '/api/health' || pathname === '/health') {
    return res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  }

  // All other routes require auth
  const authError = authenticate(req);
  if (authError) {
    return res.status(authError.status).json({ error: authError.error, debug: authError.debug });
  }

  const projects = loadJSON(projectsFile);
  const history = loadJSON(historyFile);

  // GET /api/sync - list all projects
  if ((pathname === '/api/sync' || pathname === '/sync') && req.method === 'GET') {
    const list = Object.entries(projects).map(([name, data]) => ({
      project: name,
      summary: data.summary,
      updated_at: data.updated_at
    })).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    return res.status(200).json({ projects: list });
  }

  // Match /api/sync/:project or /sync/:project
  const syncMatch = pathname.match(/^\/(?:api\/)?sync\/([^\/]+)(?:\/history)?$/);
  if (syncMatch) {
    const project = decodeURIComponent(syncMatch[1]);
    const isHistory = pathname.endsWith('/history');

    // GET /api/sync/:project/history
    if (isHistory && req.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
      const projectHistory = (history[project] || [])
        .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
        .slice(0, limit);
      return res.status(200).json({ project, history: projectHistory });
    }

    // GET /api/sync/:project
    if (req.method === 'GET') {
      const data = projects[project];
      if (!data) return res.status(404).json({ error: 'Project not found' });

      const includeFiles = url.searchParams.get('include_files') === 'true';
      const includeHistory = parseInt(url.searchParams.get('include_history')) || 0;

      const response = {
        project,
        summary: data.summary,
        claude_md: data.claude_md,
        updated_at: data.updated_at,
        metadata: data.metadata
      };

      if (includeFiles && data.files) response.files = data.files;

      if (includeHistory > 0) {
        const projectHistory = (history[project] || [])
          .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
          .slice(0, includeHistory);
        response.history = projectHistory;
      }

      return res.status(200).json(response);
    }

    // POST /api/sync/:project
    if (req.method === 'POST') {
      const body = req.body || {};
      const { claude_md, summary, files, metadata } = body;
      const now = new Date().toISOString();

      const existing = projects[project] || {};
      projects[project] = {
        claude_md: claude_md || existing.claude_md,
        summary: summary || existing.summary,
        files: files || existing.files,
        metadata: metadata || existing.metadata,
        updated_at: now
      };
      saveJSON(projectsFile, projects);

      if (summary) {
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
        saveJSON(historyFile, history);
      }

      return res.status(200).json({ success: true, project, updated_at: now });
    }

    // DELETE /api/sync/:project
    if (req.method === 'DELETE') {
      delete projects[project];
      saveJSON(projectsFile, projects);
      delete history[project];
      saveJSON(historyFile, history);
      return res.status(200).json({ success: true, deleted: project });
    }
  }

  return res.status(404).json({ error: 'Not found' });
};
