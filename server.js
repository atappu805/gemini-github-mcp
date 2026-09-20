import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Keep-alive route to prevent Render free tier from sleeping cold
app.get('/', (req, res) => res.json({ status: "active" }));
app.get('/mcp', (req, res) => res.json({ name: "github-mcp", status: "active" }));

app.post('/mcp', (req, res) => {
    const body = req.body;
    const id = body.id !== undefined ? body.id : null;

    // Handle MCP protocol initialization immediately without spawning process if it's just a handshake
    if (body.method === "initialize") {
        return res.json({
            jsonrpc: "2.0",
            id: id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "github-mcp-server", version: "1.0.0" }
            }
        });
    }

    const mcpProcess = spawn('npx', ['--no-install', '@modelcontextprotocol/server-github'], {
        env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PAT }
    });

    let outputData = '';
    let errorData = '';

    mcpProcess.stdout.on('data', (data) => { outputData += data.toString(); });
    mcpProcess.stderr.on('data', (data) => { errorData += data.toString(); });

    mcpProcess.on('close', (code) => {
        const lines = outputData.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('{')) {
                try {
                    return res.json(JSON.parse(line.trim()));
                } catch (e) {}
            }
        }
        res.json({
            jsonrpc: "2.0",
            id: id,
            result: { content: [{ type: "text", text: outputData || errorData || "executed" }] }
        });
    });

    mcpProcess.stdin.write(JSON.stringify(body) + '\n');
    mcpProcess.stdin.end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`MCP Bridge running on port ${PORT}`));
