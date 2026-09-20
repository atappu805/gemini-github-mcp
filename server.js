import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let mcpProcess = null;

app.get('/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 1. Tell Gemini where to send subsequent POST messages
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    res.write(`event: endpoint\ndata: ${proto}://${host}/message\n\n`);

    // 2. Kill existing process if Gemini reconnects
    if (mcpProcess) mcpProcess.kill();

    // 3. Boot the official GitHub MCP server
    mcpProcess = spawn('npx', ['@modelcontextprotocol/server-github'], {
        env: { 
            ...process.env, 
            GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PAT 
        }
    });

    // 4. Stream official responses back to Gemini
    mcpProcess.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('{')) {
                res.write(`event: message\ndata: ${line}\n\n`);
            }
        }
    });

    mcpProcess.stderr.on('data', (data) => console.error(`MCP Log: ${data}`));
    req.on('close', () => { if (mcpProcess) mcpProcess.kill(); });
});

app.post('/message', (req, res) => {
    if (!mcpProcess) return res.status(400).send('No active SSE connection');
    
    // Forward Gemini's JSON-RPC request to the official server
    mcpProcess.stdin.write(JSON.stringify(req.body) + '\n');
    res.send('ok');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GitHub MCP Bridge running on port ${PORT}`));

