const express = require('express');
const path = require('path');

const app = express();
const port = 3000;

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
  res.render('index', { title: 'OverClaw Dashboard', message: 'Welcome to OverClaw! Monitoring your OpenClaw activity.' });
});

// Simple /status route
app.get('/status', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
  console.log(`OverClaw running at http://0.0.0.0:${port}`);
});
