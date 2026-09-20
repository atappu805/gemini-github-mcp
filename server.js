import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.json({ name: "github-mcp-bridge", status: "active" }));
app.get('/mcp', (req, res) => res.json({ name: "github-mcp-bridge", status: "active" }));

app.post('/mcp', async (req, res) => {
    try {
        const body = req.body;
        const id = body.id !== undefined ? body.id : null;
        const method = body.method;

        if (method === "initialize") {
            return res.json({
                jsonrpc: "2.0", id: id,
                result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "github-mcp-bridge", version: "2.0.0" } }
            });
        }

        if (method === "notifications/initialized") {
            return res.status(204).send();
        }

        if (method === "tools/list") {
            return res.json({
                jsonrpc: "2.0", id: id,
                result: {
                    tools: [
                        {
                            name: "get_file_contents",
                            description: "Reads the content of a file in a GitHub repository.",
                            inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } }, required: ["owner", "repo", "path"] }
                        },
                        {
                            name: "create_pull_request",
                            description: "Creates a new branch, updates a file, and opens a Pull Request against main.",
                            inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string" }, path: { type: "string" }, content: { type: "string" }, commit_message: { type: "string" }, pr_title: { type: "string" } }, required: ["owner", "repo", "branch", "path", "content", "commit_message", "pr_title"] }
                        }
                    ]
                }
            });
        }

        if (method === "tools/call" || method === "call_tool") {
            const toolName = body.params?.name;
            const args = body.params?.arguments || {};
            const token = process.env.GITHUB_PAT;
            const ghHeaders = { "Authorization": `Bearer ${token}`, "User-Agent": "Render-Gemini-MCP", "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json" };

            let toolResult = null;

            if (toolName === "get_file_contents") {
                const owner = args.owner || "atappu805";
                const repo = args.repo || "PixelMusic";
                const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${args.path}`, { headers: ghHeaders });
                const data = await ghRes.json();
                if (!ghRes.ok) throw new Error(data.message || "Failed to fetch file");
                const decoded = decodeURIComponent(escape(atob(data.content.replace(/\s/g, ''))));
                toolResult = { path: data.path, content: decoded };
            } 
            else if (toolName === "create_pull_request") {
                const owner = args.owner || "atappu805";
                const repo = args.repo || "PixelMusic";
                const baseBranch = args.base || "main";

                const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`, { headers: ghHeaders });
                const refData = await refRes.json();
                
                await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
                    method: "POST", headers: ghHeaders, body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: refData.object.sha })
                });

                let fileSha = null;
                const fileCheck = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${args.path}?ref=${args.branch}`, { headers: ghHeaders });
                if (fileCheck.ok) fileSha = (await fileCheck.json()).sha;

                const putBody = { message: args.commit_message, content: btoa(unescape(encodeURIComponent(args.content))), branch: args.branch };
                if (fileSha) putBody.sha = fileSha;
                await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${args.path}`, { method: "PUT", headers: ghHeaders, body: JSON.stringify(putBody) });

                const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
                    method: "POST", headers: ghHeaders,
                    body: JSON.stringify({ title: args.pr_title, body: "Automated fix by Gemini Spark.", head: args.branch, base: baseBranch })
                });
                const prData = await prRes.json();
                toolResult = { status: "PR created", url: prData.html_url };
            }

            return res.json({
                jsonrpc: "2.0", id: id,
                result: { content: [{ type: "text", text: JSON.stringify(toolResult) }] }
            });
        }

        res.json({ jsonrpc: "2.0", id: id, result: {} });
    } catch (err) {
        res.json({ jsonrpc: "2.0", error: { code: -32000, message: err.message } });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Native MCP server running on port ${PORT}`));
