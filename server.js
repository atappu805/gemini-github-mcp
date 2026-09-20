import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---------- Config (set these in Render > Environment) ----------
const GITHUB_PAT = process.env.GITHUB_PAT;                 // required
const MCP_SECRET = process.env.MCP_SECRET || '';           // recommended
const DEFAULT_OWNER = 'atappu805';
const DEFAULT_REPO = 'PixelMusic';
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || `${DEFAULT_OWNER}/${DEFAULT_REPO}`)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---------- Helpers ----------
const ghHeaders = (accept = 'application/vnd.github+json') => ({
    'Authorization': `Bearer ${GITHUB_PAT}`,
    'User-Agent': 'Render-Gemini-MCP',
    'Accept': accept,
    'Content-Type': 'application/json'
});

const encodePath = (p) => String(p).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

function safeEqual(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAuthorized(req) {
    if (!MCP_SECRET) return true;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return safeEqual(bearer, MCP_SECRET) || safeEqual(req.query.key || '', MCP_SECRET);
}

function resolveRepo(args) {
    const owner = args.owner || DEFAULT_OWNER;
    const repo = args.repo || DEFAULT_REPO;
    if (!ALLOWED_REPOS.includes(`${owner}/${repo}`.toLowerCase())) {
        throw new Error(`Repo ${owner}/${repo} is not in ALLOWED_REPOS`);
    }
    return { owner, repo };
}

async function ghJson(url, options = {}) {
    const res = await fetch(url, { headers: ghHeaders(), ...options });
    const data = await res.json().catch(() => ({}));
    return { res, data };
}

// ---------- Tools ----------
const TOOLS = [
    {
        name: 'get_file_contents',
        description: 'Reads a file (or lists a directory) in a GitHub repository.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                path: { type: 'string' },
                ref: { type: 'string', description: 'Optional branch, tag or commit' }
            },
            required: ['path']
        }
    },
    {
        name: 'create_pull_request',
        description: 'Creates a new branch, updates or creates one file, and opens a Pull Request (base defaults to main).',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                base: { type: 'string' },
                branch: { type: 'string' },
                path: { type: 'string' },
                content: { type: 'string' },
                commit_message: { type: 'string' },
                pr_title: { type: 'string' }
            },
            required: ['branch', 'path', 'content', 'commit_message', 'pr_title']
        }
    }
];

async function getFileContents(args) {
    const { owner, repo } = resolveRepo(args);
    if (!args.path) throw new Error('path is required');
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(args.path)}`;
    const url = args.ref ? `${base}?ref=${encodeURIComponent(args.ref)}` : base;

    const { res, data } = await ghJson(url);
    if (!res.ok) throw new Error(data.message || `GitHub returned ${res.status}`);

    if (Array.isArray(data)) {
        return JSON.stringify(data.map(e => ({ name: e.name, path: e.path, type: e.type })), null, 2);
    }
    if (data.encoding === 'base64' && data.content) {
        return Buffer.from(data.content, 'base64').toString('utf8');
    }
    // Files over 1 MB come back without inline content, so fetch them raw
    const raw = await fetch(url, { headers: ghHeaders('application/vnd.github.raw+json') });
    if (!raw.ok) throw new Error(`GitHub returned ${raw.status} for raw file`);
    return await raw.text();
}

async function createPullRequest(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const baseBranch = args.base || 'main';

    const ref = await ghJson(`${api}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
    if (!ref.res.ok) throw new Error(`Base branch "${baseBranch}": ${ref.data.message || ref.res.status}`);

    const mk = await ghJson(`${api}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: ref.data.object.sha })
    });
    // 422 = branch already exists, which is fine, we just commit onto it
    if (!mk.res.ok && mk.res.status !== 422) throw new Error(`Create branch: ${mk.data.message || mk.res.status}`);

    const filePath = encodePath(args.path);
    const existing = await ghJson(`${api}/contents/${filePath}?ref=${encodeURIComponent(args.branch)}`);
    const putBody = {
        message: args.commit_message,
        content: Buffer.from(args.content, 'utf8').toString('base64'),
        branch: args.branch
    };
    if (existing.res.ok && existing.data.sha) putBody.sha = existing.data.sha;

    const put = await ghJson(`${api}/contents/${filePath}`, { method: 'PUT', body: JSON.stringify(putBody) });
    if (!put.res.ok) throw new Error(`Commit file: ${put.data.message || put.res.status}`);

    const pr = await ghJson(`${api}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: args.pr_title, body: 'Automated fix by Gemini Spark.', head: args.branch, base: baseBranch })
    });
    if (!pr.res.ok) throw new Error(`Open PR: ${pr.data.message || pr.res.status}`);

    return JSON.stringify({ status: 'PR created', url: pr.data.html_url, number: pr.data.number });
}

// ---------- JSON-RPC handling ----------
async function handleMessage(msg) {
    const id = msg?.id ?? null;
    const isNotification = msg?.id === undefined;
    const method = msg?.method;

    if (isNotification) return null; // notifications never get a response body

    try {
        switch (method) {
            case 'initialize': {
                const requested = msg.params?.protocolVersion;
                return {
                    jsonrpc: '2.0', id,
                    result: {
                        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'github-mcp-bridge', version: '2.1.0' }
                    }
                };
            }
            case 'ping':
                return { jsonrpc: '2.0', id, result: {} };
            case 'tools/list':
                return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
            case 'resources/list':
                return { jsonrpc: '2.0', id, result: { resources: [] } };
            case 'resources/templates/list':
                return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
            case 'prompts/list':
                return { jsonrpc: '2.0', id, result: { prompts: [] } };
            case 'tools/call':
            case 'call_tool': {
                const name = msg.params?.name;
                const args = msg.params?.arguments || {};
                try {
                    if (!GITHUB_PAT) throw new Error('GITHUB_PAT is not set on the server');
                    let text;
                    if (name === 'get_file_contents') text = await getFileContents(args);
                    else if (name === 'create_pull_request') text = await createPullRequest(args);
                    else throw new Error(`Unknown tool: ${name}`);
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
                } catch (err) {
                    // Tool failures go back as a normal result so the model can read the error
                    return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: err.message }] } };
                }
            }
            default:
                return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
        }
    } catch (err) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
    }
}

// ---------- Routes ----------
app.get('/', (req, res) => res.json({ name: 'github-mcp-bridge', status: 'active' }));

// This server has no SSE stream, so per the Streamable HTTP spec GET must be 405
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());

app.post('/mcp', async (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    }
    const body = req.body;
    if (Array.isArray(body)) {
        const out = (await Promise.all(body.map(handleMessage))).filter(Boolean);
        return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleMessage(body);
    return out ? res.json(out) : res.status(202).end();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Native MCP server running on port ${PORT}`);
    if (!GITHUB_PAT) console.warn('WARNING: GITHUB_PAT is not set');
    if (!MCP_SECRET) console.warn('WARNING: MCP_SECRET is not set, /mcp is open to anyone with the URL');
});
