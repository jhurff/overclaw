const express = require('express');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const port = 10000; // Updated port

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route - Dashboard
app.get('/', (req, res) => {
  res.render('index', { title: 'OverClaw Gateway Dashboard' });
});

// Agents screen route
app.get('/agents', (req, res) => {
  res.render('agents', { title: 'OverClaw Agent Details' });
});

// API endpoint to list OpenClaw agents (summary for dashboard card)
app.get('/api/agents', (req, res) => {
  exec('openclaw agents list --json', (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error for /api/agents: ${error}`);
      console.error(`stderr: ${stderr}`);
      console.log(`stdout: ${stdout}`);
      return res.status(500).json({ error: 'Failed to fetch agents', details: stderr, stdout: stdout });
    }
    try {
      const agents = JSON.parse(stdout);
      // For the dashboard overview, we might only need id and name
      res.json(agents.map(agent => ({ id: agent.id, name: agent.name })));
    } catch (parseError) {
      console.error(`JSON parse error for /api/agents: ${parseError}`);
      console.error(`Original stdout for /api/agents parse error: ${stdout}`);
      res.status(500).json({ error: 'Failed to parse agents data', details: parseError.message, stdout: stdout });
    }
  });
});

// API endpoint to get detailed OpenClaw sessions (for agents screen)
app.get('/api/sessions-detail', (req, res) => {
  exec('openclaw sessions --json --all-agents', (error, stdout, stderr) => { 
    if (error) {
      console.error(`exec error for /api/sessions-detail: ${error}`);
      console.error(`stderr: ${stderr}`);
      console.log(`stdout: ${stdout}`);
      return res.status(500).json({ error: 'Failed to fetch session details', details: stderr, stdout: stdout });
    }
    try {
      const sessions = JSON.parse(stdout);
      res.json(sessions);
    } catch (parseError) {
      console.error(`JSON parse error for /api/sessions-detail: ${parseError}`);
      console.error(`Original stdout for /api/sessions-detail parse error: ${stdout}`);
      res.status(500).json({ error: 'Failed to parse session details', details: parseError.message, stdout: stdout });
    }
  });
});

// NEW: Server-side debug endpoint to simulate client-side processing
app.get('/debug-agents-data', async (req, res) => {
  const debugLogs = [];
  const log = (msg, data) => debugLogs.push({ msg, data, timestamp: new Date().toISOString() });

  try {
    log('Server-side DEBUG: Initiating /api/agents...');
    const agentsRaw = await new Promise((resolve, reject) => {
      exec('openclaw agents list --json', (error, stdout, stderr) => {
        if (error) reject({ error, stderr, stdout });
        else resolve(stdout);
      });
    });
    const agents = JSON.parse(agentsRaw);
    log('Server-side DEBUG: Agents data (from /api/agents):', agents);

    log('Server-side DEBUG: Initiating /api/sessions-detail...');
    const sessionsRaw = await new Promise((resolve, reject) => {
      exec('openclaw sessions --json --all-agents', (error, stdout, stderr) => {
        if (error) reject({ error, stderr, stdout });
        else resolve(stdout);
      });
    });
    const sessionsData = JSON.parse(sessionsRaw);
    log('Server-side DEBUG: Sessions raw data (from /api/sessions-detail):', sessionsData);

    const allSessions = sessionsData.sessions || [];
    log('Server-side DEBUG: All sessions available for processing:', allSessions);

    const combinedData = agents.map(agent => {
      const agentSessions = allSessions.filter(session => {
        log(`Server-side DEBUG: Comparing agent.id: ${agent.id} with session.agentId: ${session.agentId} for session key: ${session.key}`);
        return session.agentId === agent.id;
      });
      log(`Server-side DEBUG: Filtered sessions for agent ${agent.name} (${agent.id}):`, agentSessions);

      // Sort sessions by updatedAtMs in descending order (most recent first)
      agentSessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

      // Determine last activity
      const lastActivityMs = agentSessions.length > 0 
        ? Math.max(...agentSessions.map(s => s.updatedAtMs))
        : null;
      const lastActivity = lastActivityMs ? new Date(lastActivityMs).toLocaleString() : 'N/A';

      // Determine active sessions (e.g., updated within the last 5 minutes)
      const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      const activeSessions = agentSessions.filter(s => {
        const isActive = (now - s.updatedAtMs) < ACTIVE_THRESHOLD_MS;
        log(`Server-side DEBUG: Session key: ${s.key}, updatedAtMs: ${s.updatedAtMs}, now: ${now}, ageMs: ${now - s.updatedAtMs}, threshold: ${ACTIVE_THRESHOLD_MS}. Is active? ${isActive}`);
        return isActive;
      }); 
      const activeSessionsCount = activeSessions.length;
      log(`Server-side DEBUG: Agent ${agent.name}: Active sessions (${ACTIVE_THRESHOLD_MS / 60000} min threshold):`, activeSessions);

      // Determine current task/last message from the most recent active session, then overall most recent
      const mostRelevantSession = activeSessions.length > 0 ? activeSessions[0] : (agentSessions.length > 0 ? agentSessions[0] : null);
      let currentTask = 'N/A';
      if (mostRelevantSession) {
        log(`Server-side DEBUG: Agent ${agent.name}: Most relevant session for task:`, mostRelevantSession);
        if (mostRelevantSession.message && typeof mostRelevantSession.message === 'string' && mostRelevantSession.message.length > 0) {
          currentTask = mostRelevantSession.message; 
        } else if (mostRelevantSession.lastMessage?.message && typeof mostRelevantSession.lastMessage.message === 'string' && mostRelevantSession.lastMessage.message.length > 0) {
          currentTask = mostRelevantSession.lastMessage.message; 
        } else if (mostRelevantSession.key) {
          const keyParts = mostRelevantSession.key.split(':');
          if (keyParts.includes('cron')) {
            currentTask = `Cron Job: ${keyParts[3] || 'Unknown'}`;
          } else if (keyParts.includes('subagent')) {
            currentTask = `Subagent: ${keyParts[2] || 'Unknown'}`;
          } else if (keyParts.includes('discord') || keyParts.includes('main')) {
            currentTask = `Chat Session: ${keyParts[keyParts.length - 1]}`;
          } else {
            currentTask = `Session: ${mostRelevantSession.key}`;
          }
        }
      }
      currentTask = currentTask.length > 100 ? currentTask.substring(0, 97) + '...' : currentTask; // Truncate long tasks
      
      return {
        ...agent,
        lastActivity,
        activeSessionsCount,
        currentTask,
      };
    });

    res.json({ combinedData, debugLogs });

  } catch (error) {
    log('Server-side DEBUG: Error in /debug-agents-data:', error);
    res.status(500).json({ error: 'Server-side debug failed', details: error.message, logs: debugLogs, originalError: error });
  }
});

// Simple /status route
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`OverClaw running at http://0.0.0.0:${port}`);
});
