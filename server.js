// server.js - ElevenLabs WebSocket Proxy Server
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enable CORS for your Bubble.io website
app.use(cors({
    origin: [
        'https://apruvi.ai', // Your website
        'https://www.apruvi.ai', // With www
        'http://localhost:3000', // For testing
        'https://localhost:3000'
    ],
    credentials: true
}));

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ElevenLabs WebSocket Proxy Server Running',
        timestamp: new Date().toISOString(),
        connections: wss.clients.size
    });
});

// WebSocket server for client connections
const wss = new WebSocket.Server({ server });

// Store active connections and their ElevenLabs WebSocket connections
const connections = new Map();

wss.on('connection', (clientWs, req) => {
    const clientId = generateClientId();
    console.log(`Client connected: ${clientId}`);
    
    // Store client connection
    connections.set(clientId, {
        client: clientWs,
        elevenlabs: null,
        audioBuffer: [],
        isConnected: false,
        lastActivity: Date.now()
    });

    clientWs.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            await handleClientMessage(clientId, data);
        } catch (error) {
            console.error('Error handling client message:', error);
            sendToClient(clientId, {
                type: 'error',
                message: 'Failed to process message'
            });
        }
    });

    clientWs.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        cleanup(clientId);
    });

    clientWs.on('error', (error) => {
        console.error(`Client error ${clientId}:`, error);
        cleanup(clientId);
    });

    // Send welcome message
    sendToClient(clientId, {
        type: 'connected',
        clientId: clientId,
        message: 'Connected to ElevenLabs proxy server'
    });
});

async function handleClientMessage(clientId, data) {
    const connection = connections.get(clientId);
    if (!connection) return;

    connection.lastActivity = Date.now();

    switch (data.type) {
        case 'init_conversation':
            await initializeElevenLabsConnection(clientId, data);
            break;
        
        case 'send_text':
            await sendTextToElevenLabs(clientId, data);
            break;
        
        case 'send_audio':
            await sendAudioToElevenLabs(clientId, data);
            break;
        
        case 'end_conversation':
            await endConversation(clientId);
            break;
        
        default:
            console.log(`Unknown message type: ${data.type}`);
    }
}

async function initializeElevenLabsConnection(clientId, data) {
    const connection = connections.get(clientId);
    if (!connection) return;

    const {
        agent_id,
        voice_settings = {
            stability: 0.5,
            similarity_boost: 0.8,
            style: 0.0,
            use_speaker_boost: true
        }
    } = data;

    const elevenLabsWsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agent_id}`;
    
    try {
        const elevenLabsWs = new WebSocket(elevenLabsWsUrl, {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY
            }
        });

        elevenLabsWs.on('open', () => {
            console.log(`ElevenLabs connected for client: ${clientId}`);
            connection.elevenlabs = elevenLabsWs;
            connection.isConnected = true;
            
            sendToClient(clientId, {
                type: 'elevenlabs_connected',
                message: 'Connected to ElevenLabs'
            });
        });

        elevenLabsWs.on('message', (message) => {
            try {
                const data = JSON.parse(message.toString());
                handleElevenLabsMessage(clientId, data);
            } catch (error) {
                // Handle binary audio data
                handleElevenLabsAudio(clientId, message);
            }
        });

        elevenLabsWs.on('close', () => {
            console.log(`ElevenLabs disconnected for client: ${clientId}`);
            connection.isConnected = false;
            sendToClient(clientId, {
                type: 'elevenlabs_disconnected',
                message: 'ElevenLabs connection closed'
            });
        });

        elevenLabsWs.on('error', (error) => {
            console.error(`ElevenLabs error for client ${clientId}:`, error);
            sendToClient(clientId, {
                type: 'error',
                message: 'ElevenLabs connection error'
            });
        });

    } catch (error) {
        console.error('Failed to connect to ElevenLabs:', error);
        sendToClient(clientId, {
            type: 'error',
            message: 'Failed to connect to ElevenLabs'
        });
    }
}

function handleElevenLabsMessage(clientId, data) {
    const connection = connections.get(clientId);
    if (!connection) return;

    // Forward ElevenLabs messages to client
    sendToClient(clientId, {
        type: 'elevenlabs_message',
        data: data
    });
}

function handleElevenLabsAudio(clientId, audioData) {
    const connection = connections.get(clientId);
    if (!connection) return;

    // Buffer audio for better handling of poor connections
    connection.audioBuffer.push(audioData);
    
    // Send audio to client
    sendToClient(clientId, {
        type: 'audio_chunk',
        audio: audioData.toString('base64')
    });

    // Clean old audio buffer (keep last 10 chunks)
    if (connection.audioBuffer.length > 10) {
        connection.audioBuffer = connection.audioBuffer.slice(-10);
    }
}

async function sendTextToElevenLabs(clientId, data) {
    const connection = connections.get(clientId);
    if (!connection || !connection.elevenlabs || !connection.isConnected) {
        sendToClient(clientId, {
            type: 'error',
            message: 'Not connected to ElevenLabs'
        });
        return;
    }

    try {
        const message = {
            user_audio_chunk: null,
            user_message: data.text
        };

        connection.elevenlabs.send(JSON.stringify(message));
        
        sendToClient(clientId, {
            type: 'text_sent',
            message: 'Text sent to ElevenLabs'
        });
    } catch (error) {
        console.error('Error sending text to ElevenLabs:', error);
        sendToClient(clientId, {
            type: 'error',
            message: 'Failed to send text'
        });
    }
}

async function sendAudioToElevenLabs(clientId, data) {
    const connection = connections.get(clientId);
    if (!connection || !connection.elevenlabs || !connection.isConnected) {
        sendToClient(clientId, {
            type: 'error',
            message: 'Not connected to ElevenLabs'
        });
        return;
    }

    try {
        const audioBuffer = Buffer.from(data.audio, 'base64');
        
        const message = {
            user_audio_chunk: audioBuffer.toString('base64'),
            user_message: null
        };

        connection.elevenlabs.send(JSON.stringify(message));
        
        sendToClient(clientId, {
            type: 'audio_sent',
            message: 'Audio sent to ElevenLabs'
        });
    } catch (error) {
        console.error('Error sending audio to ElevenLabs:', error);
        sendToClient(clientId, {
            type: 'error',
            message: 'Failed to send audio'
        });
    }
}

async function endConversation(clientId) {
    const connection = connections.get(clientId);
    if (!connection) return;

    if (connection.elevenlabs && connection.isConnected) {
        connection.elevenlabs.close();
    }

    sendToClient(clientId, {
        type: 'conversation_ended',
        message: 'Conversation ended'
    });
}

function sendToClient(clientId, message) {
    const connection = connections.get(clientId);
    if (connection && connection.client.readyState === WebSocket.OPEN) {
        connection.client.send(JSON.stringify(message));
    }
}

function cleanup(clientId) {
    const connection = connections.get(clientId);
    if (connection) {
        if (connection.elevenlabs) {
            connection.elevenlabs.close();
        }
        connections.delete(clientId);
    }
}

function generateClientId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Clean up inactive connections every 5 minutes
setInterval(() => {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    connections.forEach((connection, clientId) => {
        if (now - connection.lastActivity > timeout) {
            console.log(`Cleaning up inactive connection: ${clientId}`);
            cleanup(clientId);
        }
    });
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ElevenLabs WebSocket Proxy Server running on port ${PORT}`);
    console.log(`Server URL: http://localhost:${PORT}`);
});

module.exports = { app, server };