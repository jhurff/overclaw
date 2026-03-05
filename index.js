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
  exec('openclaw sessions --json --all-agents', (error, stdout, stderr) => { // Use --all-agents to get sessions across all agents
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

// Simple /status route
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`OverClaw running at http://0.0.0.0:${port}`);
});
