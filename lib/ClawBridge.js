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
            console.log('ClawBridge: WebSocket connected to Gateway. Waiting for challenge...');
            // this.isConnected = true; // Mark as connected ONLY after successful handshake
            // Do NOT send connect immediately. Wait for 'connect.challenge'.
        });

        this.ws.on('message', async (message) => {
            const data = JSON.parse(message.toString());
            // console.log('ClawBridge: Received message:', data);

            if (data.type === 'event' && data.event === 'connect.challenge') {
                console.log('ClawBridge: Received connect.challenge. Responding...');
                const nonce = data.payload.nonce;
                const ts = data.payload.ts; // Timestamp from the challenge
                
                // For now, we'll use a very basic, non-cryptographic signature for operator role.
                // For a robust, production-ready client, this would involve a cryptographic keypair
                // and signing the specific payload (client, role, scopes, token, device, nonce, ts).
                const mockPublicKey = 'OVERCLAW_PUBKEY_MOCK'; // Stable but mock public key
                // The signature should cryptographically bind the payload, nonce, and token.
                // For this diagnostic phase, we'll use a simple mock.
                const mockSignature = `mock-signature-for-${nonce}`;

                this.ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'connect-auth',
                    method: 'connect',
                    params: {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: {
                            id: 'overclaw-dashboard',
                            version: '0.1.0', // OverClaw version
                            platform: process.platform, // Dynamically get OS platform (e.g., 'linux', 'darwin')
                            mode: 'operator' // OverClaw's role as an operator
                        },
                        role: 'operator',
                        scopes: ['operator.read', 'operator.write'], // Permissions needed by OverClaw
                        auth: { token: this.apiToken },
                        locale: 'en-US',
                        userAgent: 'overclaw-dashboard/0.1.0',
                        device: {
                            id: 'overclaw-ws-client-001', // Unique ID for this OverClaw instance as a WebSocket client
                            publicKey: mockPublicKey,
                            signature: mockSignature,
                            signedAt: ts, // Use the timestamp from the challenge
                            nonce: nonce // Use the nonce from the challenge
                        }
                    }
                }));
                // After sending the connect request, the Gateway will respond with type: 'res', id: 'connect-auth'
                // This response will be handled by the responseQueue as a normal RPC response.
            } else if (data.id && this.responseQueue.has(data.id)) {
                const { resolve, reject } = this.responseQueue.get(data.id);
                this.responseQueue.delete(data.id);

                if (data.error) {
                    reject(new Error(`ClawBridge RPC Error for ID ${data.id}: ${data.error.message || JSON.stringify(data.error)}`));
                } else {
                    // Special handling for successful connect response
                    if (data.id === 'connect-auth' && data.result && data.result.type === 'hello-ok') {
                        console.log('ClawBridge: Authentication successful (hello-ok).');
                        this.isConnected = true; // Mark as connected ONLY after successful handshake
                    }
                    resolve(data.result);
                }
            } else if (data.method) {
                // Handle unsolicited notifications/events from the Gateway
                console.log('ClawBridge: Received unsolicited notification:', data);
                // TODO: Implement event handling (e.g., sessions.update, cron.triggered)
            } else if (data.id === 'connect-auth' && data.error) {
                console.error(`ClawBridge: Authentication failed (connect-auth error): ${data.error.message}`);
                this.ws.close(); // Close connection on auth failure
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
