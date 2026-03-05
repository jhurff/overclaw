const express = require('express');
const path = require('path');
const { exec } = require('child_process'); // Import child_process

const app = express();
const port = 3000;

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
  res.render('index', { title: 'OverClaw Gateway Dashboard' });
});

// API endpoint to list OpenClaw agents
app.get('/api/agents', (req, res) => {
  exec('openclaw agents list --json', (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).json({ error: 'Failed to fetch agents', details: stderr });
    }
    try {
      const agents = JSON.parse(stdout);
      res.json(agents);
    } catch (parseError) {
      console.error(`JSON parse error: ${parseError}`);
      res.status(500).json({ error: 'Failed to parse agents data', details: parseError.message });
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
