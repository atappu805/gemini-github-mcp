import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let mcpProcess = null;

// 1. Instant Health Checks so Gemini doesn't time out
app.get('/', (req, res) => res.json({ status: "active" }));
app.get('/mcp', (req, res) => res.json({ status: "active" }));

// 2. The main SSE Stream
app.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    res.write(`event: endpoint\ndata: ${proto}://${host}/message\n\n`);

    if (mcpProcess) mcpProcess.kill();

    // The Fix: '--no-install' forces it to instantly use the downloaded package
    mcpProcess = spawn('npx', ['--no-install', '@modelcontextprotocol/server-github'], {
        env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PAT }
    });

    mcpProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('{')) {
                res.write(`event: message\ndata: ${line}\n\n`);
            }
        }
    });

    mcpProcess.stderr.on('data', (data) => console.error(data.toString()));
    req.on('close', () => { if (mcpProcess) mcpProcess.kill(); });
});

// 3. Receive Messages from Gemini
app.post('/message', (req, res) => {
    if (!mcpProcess) return res.status(400).send('No connection');
    mcpProcess.stdin.write(JSON.stringify(req.body) + '\n');
    res.send('ok');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
