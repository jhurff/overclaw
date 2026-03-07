const fetch = require('node-fetch').default;

class ClawBridge {
    constructor(gatewayUrl, apiToken) {
        if (!gatewayUrl || !apiToken) {
            throw new Error('ClawBridge: Gateway URL and API Token are required.');
        }
        this.gatewayUrl = gatewayUrl.endsWith('/') ? gatewayUrl.slice(0, -1) : gatewayUrl;
        this.apiToken = apiToken;
    }

    async _call(method, endpoint, payload = {}) {
        const url = `${this.gatewayUrl}/api/v1/${endpoint}`;
        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiToken}`
                },
                body: method === 'GET' ? undefined : JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`ClawBridge API Error: ${response.status} ${response.statusText} - ${errorText}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`ClawBridge: Failed to call ${method} ${url}:`, error.message);
            throw error;
        }
    }

    // API methods for OverClaw to consume
    async getAgents() {
        return this._call('GET', 'agents/list');
    }

    async getSessions() {
        // The OpenClaw API equivalent of 'sessions --json --all-agents'
        // might be sessions/list with appropriate query parameters if supported
        // For now, assume sessions/list returns comprehensive data or adjust as needed.
        return this._call('GET', 'sessions/list');
    }

    async getCronJobs() {
        return this._call('GET', 'cron/list');
    }

    async sendMessage(target, message) {
        return this._call('POST', 'message/send', { target, message });
    }

    // TODO: Add WebSocket integration for real-time events in a later phase
}

module.exports = ClawBridge;
