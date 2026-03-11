# OverClaw

**OverClaw** is a real-time oversight webapp for OpenClaw. It provides a read-only view of OpenClaw agent and sub-agent configurations, chronological records of changes across chat channels, active projects, reports produced, and documents created.

## Features (In Development)

- **Agent Configuration Tracking:** View all configured agents and sub-agents within OpenClaw
- **Real-Time Activity Log:** Chronological record of changes and activities across all channels
- **Project Dashboard:** Monitor active projects, statuses, and deliverables
- **Report Registry:** Track reports generated and documents created
- **Configuration Validation:** Validate agent and sub-agent configurations

## Getting Started

### Prerequisites

- Node.js v25.2.1 or higher
- npm

### Installation

```bash
git clone https://github.com/jhurff/overclaw.git
cd overclaw
npm install
```

### Running OverClaw

```bash
export OPENCLAW_GATEWAY_URL=<Your OpenClaw Gateway IP>
export OPENCLAW_API_TOKEN=<Your OpenClaw Token>
npm start
```

The webapp will be available at `http://localhost:3000` (or configured port).

## Development

```bash
npm run dev
```

## License

OverClaw is released under the [MIT License](LICENSE).

## Author

Jimmy Hurff
