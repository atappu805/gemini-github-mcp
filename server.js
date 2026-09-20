import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check routes
app.get('/', (req, res) => res.json({ status: "active", protocol: "mcp" }));
app.get('/mcp', (req, res) => res.json({ status: "active", protocol: "mcp" }));

// Handle synchronous JSON-RPC calls from Gemini Spark
app.post('/mcp', (req, res) => {
    const mcpProcess = spawn('npx', ['--no-install', '@modelcontextprotocol/server-github'], {
        env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PAT }
    });

    let outputData = '';
    let errorData = '';

    mcpProcess.stdout.on('data', (data) => {
        outputData += data.toString();
    });

    mcpProcess.stderr.on('data', (data) => {
        errorData += data.toString();
    });

    mcpProcess.on('close', (code) => {
        if (code !== 0 && !outputData) {
            return res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: errorData || "MCP server failed" }
            });
        }

        // Parse lines from output and find the valid JSON-RPC response
        const lines = outputData.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('{')) {
                try {
                    const jsonRes = JSON.parse(line.trim());
                    return res.json(jsonRes);
                } catch (e) {
                    // Continue scanning lines if not valid JSON yet
                }
            }
        }

        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid JSON-RPC response generated", details: outputData }
        });
    });

    // Send Gemini's payload directly into the official server's standard input
    mcpProcess.stdin.write(JSON.stringify(req.body) + '\n');
    mcpProcess.stdin.end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Sync MCP Bridge running on port ${PORT}`));
