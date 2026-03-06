const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs').promises; // For async file operations

const app = express();
const port = 10000; // Updated port

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to extract agent ID from session key (duplicate for server-side use)
function getAgentIdFromSessionKey(sessionKey) {
    const parts = sessionKey.split(':');
    if (parts.length > 1 && parts[0] === 'agent') {
        return parts[1]; // e.g., 'main', 'sheeba-m', 'buster-mcthunderstick'
    }
    return null; 
}

// Root route - Dashboard
app.get('/', (req, res) => {
  res.render('index', { title: 'OverClaw Gateway Dashboard' });
});

// Agents screen route
app.get('/agents', (req, res) => {
  res.render('agents', { title: 'OverClaw Agent Details' });
});

// Config Viewer screen route
app.get('/config', (req, res) => {
  res.render('config', { title: 'OverClaw Agent Configuration Viewer' });
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
      res.json(agents.map(agent => ({
        id: agent.id, 
        name: agent.name,
        workspace: agent.workspace, // Include workspace for file path construction
        agentDir: agent.agentDir // Include agentDir for file path construction
      })));
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

// Whitelisted Git repositories for history viewing
const WHITELISTED_GIT_REPOS = [
  path.join(process.env.HOME, 'projects', 'overclaw'),
  path.join(process.env.HOME, 'weedstock_project'),
  // Add other Git-managed project paths here as needed for auditing
];

// Security function to validate file paths
const ALLOWED_CONFIG_FILES_MAIN_WORKSPACE = [
    'SOUL.md',
    'USER.md',
    'AGENTS.md',
    'TOOLS.md',
    'MEMORY.md', 
    'DELIVERABLES.md', 
];

const ALLOWED_DATA_MEMORY_FILES = [
    'projects_log.md',
    // Add other generic memory files stored in ~/.openclaw/data/memory/
];

const ALLOWED_SUBAGENT_CORE_CONFIG_FILES = [
  'SOUL.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
];

// Regex for OpenClaw usage reports (e.g., openclaw_usage_report_YYYY-MM-DD.md)
const OPENCLAW_USAGE_REPORT_PATTERN = /^openclaw_usage_report_\d{4}-\d{2}-\d{2}\.md$/;

async function isValidAgentConfigFile(agentId, requestedFilePath, agentDetails) {
    const WORKSPACE_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'workspace');
    const DATA_MEMORY_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'data', 'memory');

    // Normalize requested path for security checks
    const normalizedPath = path.normalize(requestedFilePath);

    // 1. Prevent directory traversal (e.g., ../../)
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
        console.warn(`Security alert: Path traversal attempt detected: ${requestedFilePath}`);
        return false;
    }

    // 2. Check for main agent's workspace files
    if (agentId === 'main') {
        if (ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.includes(normalizedPath)) {
            return true; 
        }
        // Daily memory files in main agent's workspace memory (e.g., memory/YYYY-MM-DD.md)
        if (normalizedPath.startsWith('memory/') && normalizedPath.match(/^memory\/\d{4}-\d{2}-\d{2}\.md$/)) {
            return true; 
        }
        // Other specific memory files in the shared data/memory folder (e.g., projects_log.md)
        if (ALLOWED_DATA_MEMORY_FILES.includes(normalizedPath)) {
            return true;
        }
        // OpenClaw usage reports in ~/.openclaw/data/memory/
        if (normalizedPath.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
          return true;
        }
    }

    // 3. Check for specific subagent files
    if (agentDetails && agentDetails.agentDir) {
      // Core config files for subagents (e.g., SOUL.md in their agentDir)
      if (ALLOWED_SUBAGENT_CORE_CONFIG_FILES.includes(normalizedPath)) {
          // Construct the full path to verify it's within the agent's own agentDir
          const expectedFullPath = path.join(agentDetails.agentDir, normalizedPath);
          // Check if this file actually exists at the expected path
          try {
            await fs.access(expectedFullPath); 
            return true;
          } catch (e) {
            console.warn(`Security alert: Subagent config file ${expectedFullPath} not found or accessible.`);
            return false;
          }
      }
    }
    
    // 4. Check for specific subagent memory files in ~/.openclaw/data/memory/AGENT_ID/...
    if (normalizedPath.startsWith(`memory/${agentId}/`)) {
        const relativeToAgentMemoryDir = normalizedPath.substring(`memory/${agentId}/`.length);

        // Subagent's MEMORY.md (e.g., memory/sheeba-m/MEMORY.md)
        if (relativeToAgentMemoryDir === 'MEMORY.md') {
            return true;
        }
        // Subagent's daily memory files (e.g., memory/sheeba-m/YYYY-MM-DD.md)
        if (relativeToAgentMemoryDir.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
            return true;
        }
    }

    // Add checks for other specific files that are NOT in git but are safe to read, e.g. openclaw.json
    if (agentId === 'main' && normalizedPath === 'openclaw.json') {
      return true;
    }

    console.warn(`Security alert: Unauthorized file access for agent ${agentId}, path: ${requestedFilePath}`);
    return false;
}

// Function to get the full absolute path based on agentId and relative filePath
function getFullPath(agentId, filePath, agentDetails) {
    const WORKSPACE_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'workspace');
    const DATA_MEMORY_BASE_PATH = path.join(process.env.HOME, '.openclaw', 'data', 'memory');

    let fullPath;
    if (agentId === 'main') {
        if (filePath === 'openclaw.json') {
            fullPath = path.join(process.env.HOME, '.openclaw', filePath); // openclaw.json is at ~/.openclaw/
        } else if (filePath.startsWith('memory/')) {
            // Differentiate between workspace memory (e.g., memory/YYYY-MM-DD.md) and data/memory (e.g., projects_log.md, usage reports)
            if (ALLOWED_DATA_MEMORY_FILES.includes(filePath) || filePath.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
              fullPath = path.join(DATA_MEMORY_BASE_PATH, filePath);
            } else {
              fullPath = path.join(WORKSPACE_BASE_PATH, filePath); // Workspace memory files
            }
        } else {
            fullPath = path.join(WORKSPACE_BASE_PATH, filePath); // Other workspace files
        }
    } else { // For subagents
        // Core config files in agent's own agentDir
        if (agentDetails && agentDetails.agentDir && ALLOWED_SUBAGENT_CORE_CONFIG_FILES.includes(filePath)) {
            fullPath = path.join(agentDetails.agentDir, filePath);
        }
        // Memory files in ~/.openclaw/data/memory/AGENT_ID/
        else if (filePath.startsWith(`memory/${agentId}/`)) {
            // Reconstruct path for subagent-specific memory files
            fullPath = path.join(DATA_MEMORY_BASE_PATH, agentId, filePath.substring(`memory/${agentId}/`.length));
        }
    }
    return fullPath;
}

// Function to find if a given file path belongs to a whitelisted Git repo
async function getGitRepoPathForFile(fullFilePath) {
  for (const repoPath of WHITELISTED_GIT_REPOS) {
    if (fullFilePath.startsWith(repoPath)) {
      try {
        // Verify it's actually a git repo (contains .git directory)
        await fs.access(path.join(repoPath, '.git'));
        return repoPath;
      } catch (e) {
        // Not a valid git repo or .git not accessible, continue
      }
    }
  }
  return null;
}

// API endpoint to list discoverable config files for an agent
app.get('/api/agent-config-files/:agentId', async (req, res) => {
  const { agentId } = req.params;
  // Fetch agent details to get their workspace/agentDir if needed for more dynamic discovery
  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const discoverableFiles = [];
  
  // Add hardcoded common config files for main agent
  if (agentId === 'main') {
      ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.forEach(file => {
          discoverableFiles.push({
              name: file,
              path: file,
              type: 'config',
              agentId: agent.id,
              isVersionControlled: false // Determined dynamically below
          });
      });
      // Add openclaw.json explicitly
      discoverableFiles.push({
          name: 'openclaw.json',
          path: 'openclaw.json',
          type: 'config',
          agentId: agent.id,
          isVersionControlled: false 
      });

      // Add Model Settings as a special entry
      discoverableFiles.push({
        name: 'Model Settings',
        path: '__model_settings__', // Special identifier
        type: 'setting',
        agentId: agent.id,
        isVersionControlled: false
      });

      // Add projects_log.md for main agent (it's in ~/.openclaw/data/memory/)
      discoverableFiles.push({
        name: 'projects_log.md',
        path: 'projects_log.md',
        type: 'project',
        agentId: agent.id,
        isVersionControlled: false
      });
  } else { // For subagents, add their core config files and special memory files
      ALLOWED_SUBAGENT_CORE_CONFIG_FILES.forEach(file => {
          discoverableFiles.push({
              name: file,
              path: file,
              type: 'config',
              agentId: agent.id,
              isVersionControlled: false // Determined dynamically below
          });
      });
  }

  // Dynamically find daily memory files for main agent in workspace memory
  if (agentId === 'main') {
    const mainWorkspaceMemoryPath = path.join(process.env.HOME, '.openclaw', 'workspace', 'memory');
    try {
        const files = await fs.readdir(mainWorkspaceMemoryPath);
        for (const file of files) {
            if (file.match(/^\d{4}-\d{2}-\d{2}\.md$/) || ALLOWED_CONFIG_FILES_MAIN_WORKSPACE.includes(`memory/${file}`)) {
                discoverableFiles.push({
                    name: file,
                    path: `memory/${file}`,
                    type: 'memory',
                    agentId: agent.id,
                    isVersionControlled: false
                });
            }
        }
    } catch (e) {
        // console.error(`Error reading main agent workspace memory dir: ${e}`); // Expected if dir doesn't exist
    }
  }

  // Dynamically find OpenClaw usage reports for main agent in data/memory
  if (agentId === 'main') {
    const mainDataMemoryPath = path.join(process.env.HOME, '.openclaw', 'data', 'memory');
    try {
        const files = await fs.readdir(mainDataMemoryPath);
        for (const file of files) {
            if (file.match(OPENCLAW_USAGE_REPORT_PATTERN)) {
                discoverableFiles.push({
                    name: file,
                    path: file,
                    type: 'report',
                    agentId: agent.id,
                    isVersionControlled: false
                });
            }
        }
    } catch (e) {
        // console.error(`Error reading main agent data memory dir for reports: ${e}`); // Expected if dir doesn't exist
    }
  }
  
  // Dynamically find memory files for specific subagents in their data/memory folder
  // These are located in ~/.openclaw/data/memory/AGENT_ID/...
  const subagentDataMemoryPath = path.join(process.env.HOME, '.openclaw', 'data', 'memory', agentId);
  try {
      const files = await fs.readdir(subagentDataMemoryPath);
      for (const file of files) {
          // Only allow MEMORY.md and daily memory files for subagents for now
          if (file === 'MEMORY.md' || file.match(/^\d{4}-\d{2}-\d{2}\.md$/)) {
              discoverableFiles.push({
                  name: file,
                  path: `memory/${agentId}/${file}`,
                  type: 'memory',
                  agentId: agent.id,
                  isVersionControlled: false
              });
          }
      }
  } catch (e) {
      // console.log(`No specific memory dir for subagent ${agentId}: ${e.message}`); // Expected for many agents
  }

  // Now, dynamically determine if a discovered file is version controlled
  for (const file of discoverableFiles) {
      // Only check version control for actual files, not special settings entries
      if (file.type !== 'setting') {
        const fullFilePath = getFullPath(agentId, file.path, agent);
        if (fullFilePath) {
            const repoPath = await getGitRepoPathForFile(fullFilePath);
            file.isVersionControlled = !!repoPath;
        }
      }
  }

  res.json(discoverableFiles);
});

// API endpoint to get content of a specific file
app.get('/api/file-content', async (req, res) => {
  const { agentId, filePath } = req.query;

  if (!agentId || !filePath) {
    return res.status(400).json({ error: 'Missing agentId or filePath' });
  }

  // Fetch agent details to pass to security and path resolution functions
  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  // *** SECURITY CRITICAL: Validate file path strictly ***
  if (!await isValidAgentConfigFile(agentId, filePath, agent)) { // Pass agent details for validation
    return res.status(403).json({ error: 'Unauthorized file access attempt' });
  }

  const fullPath = getFullPath(agentId, filePath, agent);
  if (!fullPath) {
      return res.status(500).json({ error: 'Could not determine full path for file.' });
  }

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (error) {
    console.error(`Error reading file ${fullPath}: ${error}`);
    res.status(500).json({ error: 'Failed to read file', details: error.message });
  }
});

// API endpoint to get Git history for a specific file
app.get('/api/file-history', async (req, res) => {
  const { agentId, filePath } = req.query;

  if (!agentId || !filePath) {
    return res.status(400).json({ error: 'Missing agentId or filePath' });
  }

  // Fetch agent details to pass to security and path resolution functions
  const agentInfoResponse = await fetch(`http://localhost:${port}/api/agents`); 
  const agents = await agentInfoResponse.json();
  const agent = agents.find(a => a.id === agentId);

  // 1. Security check: Ensure it's a file we allow viewing content for
  if (!await isValidAgentConfigFile(agentId, filePath, agent)) { // Pass agent details for validation
      return res.status(403).json({ error: 'Unauthorized file history access attempt' });
  }

  // 2. Get the full absolute path of the file
  const fullFilePath = getFullPath(agentId, filePath, agent);
  if (!fullFilePath) {
      return res.status(500).json({ error: 'Could not determine full path for file history.' });
  }

  // 3. Determine if the file is within a whitelisted Git repository
  const repoPath = await getGitRepoPathForFile(fullFilePath);
  if (!repoPath) {
    return res.status(404).json({ error: 'File not found in a whitelisted Git repository.', fullFilePath });
  }

  // 4. Get the file path relative to the Git repository root
  const relativeFilePath = path.relative(repoPath, fullFilePath);

  // 5. Execute git log command
  exec(`git log --pretty=format:'%h|%an|%ad|%s' --date=short -- "${relativeFilePath}"`, { cwd: repoPath }, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error for git log on ${relativeFilePath} in ${repoPath}: ${error}`);
      return res.status(500).json({ error: 'Failed to fetch git history', details: stderr, stdout: stdout });
    }

    const commits = stdout.split('\n').filter(line => line.trim() !== '').map(line => {
      const parts = line.split('|');
      return {
        hash: parts[0],
        author: parts[1],
        date: parts[2],
        subject: parts[3]
      };
    });
    res.json(commits);
  });
});

// NEW API endpoint to get Model Configuration for a specific agent
app.get('/api/agent-model-settings/:agentId', async (req, res) => {
  const { agentId } = req.params;

  const openclawConfigPath = path.join(process.env.HOME, '.openclaw', 'openclaw.json');

  try {
    const configContent = await fs.readFile(openclawConfigPath, 'utf-8');
    const openclawConfig = JSON.parse(configContent);

    const globalDefaultModel = openclawConfig.agents?.defaults?.model || 'Not set';
    let agentSpecificModel = 'Not set';
    let modelOrder = [];
    let agentFound = false;

    // Find the specific agent's configuration
    if (openclawConfig.agents?.list) {
      const agentConfig = openclawConfig.agents.list.find(a => a.id === agentId);
      if (agentConfig) {
        agentFound = true;
        agentSpecificModel = agentConfig.model || globalDefaultModel; // Fallback to global default
        modelOrder = agentConfig.modelOrder || [];
      }
    }

    res.json({
      agentId,
      globalDefaultModel,
      agentSpecificModel,
      modelOrder,
      agentFound
    });

  } catch (error) {
    console.error(`Error fetching model settings for ${agentId}: ${error}`);
    res.status(500).json({ error: 'Failed to fetch model settings', details: error.message });
  }
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

    // Normalize sessions to always have updatedAtMs
    const allSessions = (sessionsData.sessions || []).map(s => ({
        ...s,
        updatedAtMs: s.updatedAtMs || (s.updatedAt ? new Date(s.updatedAt).getTime() : undefined)
    }));
    log('Server-side DEBUG: All sessions available for processing (normalized updatedAtMs):', allSessions);

    const combinedData = agents.map(agent => {
      const agentSessions = allSessions.filter(session => {
          const extractedAgentId = getAgentIdFromSessionKey(session.key);
          log(`Server-side DEBUG: Comparing agent.id: ${agent.id} with extractedAgentId: ${extractedAgentId} for session key: ${session.key} (raw session.agentId: ${session.agentId})`);
          return extractedAgentId === agent.id;
      });
      log(`Server-side DEBUG: Filtered sessions for agent ${agent.name} (${agent.id}):`, agentSessions);
      
      // Sort sessions by updatedAtMs in descending order (most recent first)
      agentSessions.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)); // Handle undefined updatedAtMs during sort

      // Determine last activity
      const lastActivityMs = agentSessions.length > 0 
          ? Math.max(...agentSessions.filter(s => s.updatedAtMs !== undefined).map(s => s.updatedAtMs))
          : null; 
      const lastActivity = lastActivityMs ? new Date(lastActivityMs).toLocaleString() : 'N/A';

      // Determine active sessions (e.g., updated within the last 5 minutes)
      const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      const activeSessions = agentSessions.filter(s => {
          const ageMs = now - (s.updatedAtMs || 0); 
          const isActive = (s.updatedAtMs !== undefined) && (ageMs < ACTIVE_THRESHOLD_MS); 
          log(`Server-side DEBUG: Session key: ${s.key}, updatedAtMs: ${s.updatedAtMs}, now: ${now}, ageMs: ${ageMs}, threshold: ${ACTIVE_THRESHOLD_MS}. Is active? ${isActive}`);
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
              }
              // Only assign if currentTask is still N/A or if a more specific task is found.
              if (currentTask === 'N/A') {
                  currentTask = `Chat Session: ${keyParts[keyParts.length - 1]}`;
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
