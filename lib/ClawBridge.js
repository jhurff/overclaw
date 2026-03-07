const WebSocket = require('ws');

class ClawBridge {
    constructor(gatewayUrl, apiToken) {
        if (!gatewayUrl || !apiToken) {
            throw new Error('ClawBridge: Gateway URL and API Token are required.');
        }
        this.gatewayUrl = gatewayUrl.startsWith('http') ? gatewayUrl.replace('http', 'ws') : gatewayUrl; // Convert http to ws for WebSocket
        this.apiToken = apiToken;

        this.ws = null;
        this.requestCounter = 0;
        this.responseQueue = new Map(); // Map to store pending RPC requests
        this.isConnected = false;

        this._connectWebSocket();
    }

    _connectWebSocket() {
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log('ClawBridge: WebSocket connected to Gateway.');
            this.isConnected = true;
            // Send authentication token immediately after connection
            // OpenClaw Gateway expects a specific 'connect' RPC method for authentication.
            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 'auth',
                method: 'connect',
                params: { auth: { token: this.apiToken } }
            }));
        });

        this.ws.on('message', (message) => {
            const data = JSON.parse(message.toString());
            // console.log('ClawBridge: Received message:', data);

            if (data.id && this.responseQueue.has(data.id)) {
                const { resolve, reject } = this.responseQueue.get(data.id);
                this.responseQueue.delete(data.id);

                if (data.error) {
                    reject(new Error(`ClawBridge RPC Error for ID ${data.id}: ${data.error.message || JSON.stringify(data.error)}`));
                } else {
                    resolve(data.result);
                }
            } else if (data.method) {
                // Handle unsolicited notifications/events from the Gateway
                console.log('ClawBridge: Received unsolicited notification:', data);
                // TODO: Implement event handling (e.g., sessions.update, cron.triggered)
            } else if (data.id === 'auth' && data.error) {
                console.error(`ClawBridge: Authentication failed: ${data.error.message}`);
                this.ws.close(); // Close connection on auth failure
            } else if (data.id === 'auth' && data.result === true) {
                console.log('ClawBridge: Authentication successful.');
            }
        });

        this.ws.on('error', (error) => {
            console.error('ClawBridge: WebSocket error:', error.message);
            this.isConnected = false;
            // Reject all pending requests on error
            this.responseQueue.forEach(({ reject }, id) => {
                reject(new Error(`ClawBridge WebSocket error: ${error.message}`));
                this.responseQueue.delete(id);
            });
        });

        this.ws.on('close', (code, reason) => {
            console.log(`ClawBridge: WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isConnected = false;
            // Reject all pending requests on close
            this.responseQueue.forEach(({ reject }, id) => {
                reject(new Error(`ClawBridge WebSocket closed (Code: ${code}, Reason: ${reason.toString()})`));
                this.responseQueue.delete(id);
            });
            // Attempt to reconnect after a delay
            setTimeout(() => this._connectWebSocket(), 5000); // Reconnect after 5 seconds
        });
    }

    async _rpcCall(method, params = {}) {
        if (!this.isConnected) {
            console.warn('ClawBridge: Not connected to WebSocket, waiting...');
            await new Promise(resolve => {
                const checkConnection = setInterval(() => {
                    if (this.isConnected) {
                        clearInterval(checkConnection);
                        resolve();
                    }
                }, 100); // Check every 100ms
            });
        }

        const id = `rpc-${++this.requestCounter}`;
        return new Promise((resolve, reject) => {
            this.responseQueue.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: id,
                method: method,
                params: params
            }));
        });
    }

    // API methods for OverClaw to consume
    async getAgents() {
        return this._rpcCall('agents.list');
    }

    async getSessions() {
        return this._rpcCall('sessions.list', { includeTools: true }); // Requesting includeTools for richer session data
    }

    async getCronJobs() {
        return this._rpcCall('cron.list');
    }

    async sendMessage(target, message) {
        return this._rpcCall('message.send', { target, message });
    }

    // Close WebSocket connection cleanly on app shutdown
    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

module.exports = ClawBridge;
