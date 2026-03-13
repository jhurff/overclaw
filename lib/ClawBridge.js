const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Path to persist the keypair so device.id stays stable across restarts
const KEYPAIR_PATH = path.join(process.env.HOME || '.', '.overclaw-device-keypair.json');

function loadOrCreateKeypair() {
    if (fs.existsSync(KEYPAIR_PATH)) {
        try {
            const saved = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
            return {
                privateKey: crypto.createPrivateKey({
                    key: Buffer.from(saved.privateKeyHex, 'hex'),
                    format: 'der',
                    type: 'pkcs8'
                }),
                publicKeyB64: saved.publicKeyB64,
                deviceId: saved.deviceId
            };
        } catch (e) {
            console.warn('ClawBridge: Failed to load saved keypair, generating new one:', e.message);
        }
    }

    // Generate a fresh Ed25519 keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

    // Export public key as raw 32 bytes, then base64url-encode it
    const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const pubKeyRaw = pubKeyDer.slice(-32); // last 32 bytes are the raw Ed25519 public key
    const publicKeyB64 = pubKeyRaw.toString('base64url');

    // Derive device.id from public key (SHA-256 of raw public key bytes, hex-encoded)
    const deviceId = crypto.createHash('sha256').update(pubKeyRaw).digest('hex');

    // Persist for stable identity across restarts
    const privKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
    fs.writeFileSync(KEYPAIR_PATH, JSON.stringify({
        privateKeyHex: privKeyDer.toString('hex'),
        publicKeyB64,
        deviceId
    }), 'utf8');

    console.log(`ClawBridge: Generated new device identity. ID: ${deviceId}`);
    return { privateKey, publicKeyB64, deviceId };
}

class ClawBridge {
    constructor(gatewayUrl, apiToken) {
        if (!gatewayUrl || !apiToken) {
            throw new Error('ClawBridge: Gateway URL and API Token are required.');
        }
        // Normalize URL: http -> ws, https -> wss
        this.gatewayUrl = gatewayUrl.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`);
        this.apiToken = apiToken;

        this.ws = null;
        this.requestCounter = 0;
        this.responseQueue = new Map();
        this.isConnected = false;

        // Load or generate persistent Ed25519 keypair
        const keypair = loadOrCreateKeypair();
        this._privateKey = keypair.privateKey;
        this._publicKeyB64 = keypair.publicKeyB64;
        this._deviceId = keypair.deviceId;

        this._connectWebSocket();
    }

    _signPayload(nonce, ts) {
        // Sign: nonce + "|" + ts + "|" + role + "|" + scopes joined
        // This matches OpenClaw's v2 signature payload format.
        // If still rejected, try just nonce alone (v1 fallback).
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write'];
        const payloadStr = [nonce, ts, role, ...scopes].join('|');
        const sig = crypto.sign(null, Buffer.from(payloadStr, 'utf8'), this._privateKey);
        return sig.toString('base64url'); // 88 base64url chars = 64 bytes
    }

    _connectWebSocket() {
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
            console.log('ClawBridge: WebSocket connected to Gateway. Waiting for challenge...');
        });

        this.ws.on('message', async (message) => {
            const data = JSON.parse(message.toString());

            if (data.type === 'event' && data.event === 'connect.challenge') {
                console.log('ClawBridge: Received connect.challenge. Responding...');
                const nonce = data.payload.nonce;
                const ts = data.payload.ts || Date.now();

                const signature = this._signPayload(nonce, ts);

                const connectPayload = {
                    type: 'req',                    // ← NOT jsonrpc: '2.0'
                    id: 'connect-auth',
                    method: 'connect',
                    params: {
                        minProtocol: 3,
                        maxProtocol: 3,
                        client: {
                            id: 'cli',              // ← must be a value from GATEWAY_CLIENT_ID_SET
                            version: '0.1.0',
                            platform: process.platform,
                            mode: 'cli'
                        },
                        role: 'operator',
                        scopes: ['operator.read', 'operator.write'],
                        caps: [],
                        commands: [],
                        permissions: {},
                        auth: { token: this.apiToken },
                        locale: 'en-US',
                        userAgent: 'overclaw-dashboard/0.1.0',
                        device: {
                            id: this._deviceId,     // ← derived from public key, not hardcoded
                            publicKey: this._publicKeyB64, // ← base64url, not hex
                            signature: signature,   // ← real Ed25519 sig, base64url
                            signedAt: ts,
                            nonce: nonce
                        }
                    }
                };

                const jsonPayload = JSON.stringify(connectPayload);
                console.log('ClawBridge: Sending connect payload:', jsonPayload);
                this.ws.send(jsonPayload);

            } else if (data.type === 'res' && data.id === 'connect-auth') {
                // Successful connect response
                if (data.ok && data.payload?.type === 'hello-ok') {
                    console.log('ClawBridge: Authentication successful (hello-ok).');
                    this.isConnected = true;

                    // Persist device token for future connections (avoids re-pairing)
                    if (data.payload.auth?.deviceToken) {
                        console.log('ClawBridge: Received device token, storing for future use.');
                        this._deviceToken = data.payload.auth.deviceToken;
                    }

                    // Resolve any pending connect-auth promise
                    if (this.responseQueue.has('connect-auth')) {
                        const { resolve } = this.responseQueue.get('connect-auth');
                        this.responseQueue.delete('connect-auth');
                        resolve(data.payload);
                    }
                } else if (data.error) {
                    console.error(`ClawBridge: Authentication failed:`, data.error);
                    this.ws.close();
                }

            } else if (data.type === 'res' && data.id && this.responseQueue.has(data.id)) {
                const { resolve, reject } = this.responseQueue.get(data.id);
                this.responseQueue.delete(data.id);

                if (data.error) {
                    reject(new Error(`ClawBridge RPC Error for ID ${data.id}: ${data.error.message || JSON.stringify(data.error)}`));
                } else {
                    resolve(data.payload ?? data.result);
                }

            } else if (data.type === 'event') {
                // Handle unsolicited gateway events
                console.log('ClawBridge: Received event:', data.event);
            }
        });

        this.ws.on('error', (error) => {
            console.error('ClawBridge: WebSocket error:', error.message);
            this.isConnected = false;
            this.responseQueue.forEach(({ reject }, id) => {
                reject(new Error(`ClawBridge WebSocket error: ${error.message}`));
            });
            this.responseQueue.clear();
        });

        this.ws.on('close', (code, reason) => {
            console.log(`ClawBridge: WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
            this.isConnected = false;
            this.responseQueue.forEach(({ reject }) => {
                reject(new Error(`ClawBridge WebSocket closed (Code: ${code}, Reason: ${reason.toString()})`));
            });
            this.responseQueue.clear();
            setTimeout(() => this._connectWebSocket(), 5000);
        });
    }

    async _rpcCall(method, params = {}) {
        if (!this.isConnected) {
            console.warn('ClawBridge: Not connected to WebSocket, waiting...');
            await new Promise(resolve => {
                const check = setInterval(() => {
                    if (this.isConnected) { clearInterval(check); resolve(); }
                }, 100);
            });
        }

        const id = `rpc-${++this.requestCounter}`;
        return new Promise((resolve, reject) => {
            this.responseQueue.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({
                type: 'req',    // ← NOT jsonrpc: '2.0'
                id,
                method,
                params
            }));
        });
    }

    async getAgents()   { return this._rpcCall('agents.list'); }
    async getSessions() { return this._rpcCall('sessions.list', { includeTools: true }); }
    async getCronJobs() { return this._rpcCall('cron.list'); }
    async sendMessage(target, message) { return this._rpcCall('message.send', { target, message }); }

    close() { if (this.ws) this.ws.close(); }
}

module.exports = ClawBridge;
