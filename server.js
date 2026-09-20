import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use((req, res, next) => {
    // req.path has no query string, so MCP_SECRET never reaches the logs
    res.on('finish', () => console.log(`${req.method} ${req.path} ${req.body?.method ?? ''} -> ${res.statusCode}`));
    next();
});

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
        description: 'Reads a file (or lists a directory) in a GitHub repository. Large files are returned in chunks of about 28000 characters: use start_line and end_line to read further.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                path: { type: 'string' },
                ref: { type: 'string', description: 'Optional branch, tag or commit' },
                start_line: { type: 'integer', description: 'Optional 1-based first line to return' },
                end_line: { type: 'integer', description: 'Optional last line to return' }
            },
            required: ['path']
        }
    },
    {
        name: 'create_pull_request',
        description: 'Creates a new branch, changes one or more files, and opens ONE Pull Request (base defaults to main). Use "files": a list of {path, edits} to change several files at once (for example a Kotlin file and AndroidManifest.xml). Each edit is a {find, replace} snippet applied on the server; "find" must match the file exactly once. Only pass full "content" for new or small files.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                base: { type: 'string' },
                branch: { type: 'string' },
                files: {
                    type: 'array',
                    description: 'Files to change in this PR',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            edits: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: { find: { type: 'string' }, replace: { type: 'string' } },
                                    required: ['find', 'replace']
                                }
                            },
                            content: { type: 'string', description: 'Full content (new or small files only)' }
                        },
                        required: ['path']
                    }
                },
                path: { type: 'string', description: 'Single-file form: use "files" instead when changing several files' },
                edits: {
                    type: 'array',
                    description: 'Find/replace edits applied in order to the existing file',
                    items: {
                        type: 'object',
                        properties: { find: { type: 'string' }, replace: { type: 'string' } },
                        required: ['find', 'replace']
                    }
                },
                content: { type: 'string', description: 'Full new file content (only for new or small files)' },
                commit_message: { type: 'string' },
                pr_title: { type: 'string' }
            },
            required: ['branch', 'commit_message', 'pr_title']
        }
    }
];

const MAX_CHARS = 28000; // keeps each reply under the ~32000 chars Gemini shows before truncating

function sliceText(text, args) {
    const explicit = args.start_line !== undefined || args.end_line !== undefined;
    if (!explicit && text.length <= MAX_CHARS) return text;

    const lines = text.split('\n');
    const total = lines.length;
    const start = Math.min(Math.max(1, parseInt(args.start_line, 10) || 1), total);
    let end = Math.min(parseInt(args.end_line, 10) || total, total);

    let acc = 0, n = 0;
    for (const l of lines.slice(start - 1, end)) {
        if (n > 0 && acc + l.length + 1 > MAX_CHARS) break;
        acc += l.length + 1;
        n++;
    }
    end = start + n - 1;

    const body = lines.slice(start - 1, end).join('\n');
    const more = end < total ? `\n[More: call again with start_line=${end + 1}]` : '';
    return `[lines ${start}-${end} of ${total}; ${text.length} chars in file]\n${body}${more}`;
}

// Reads one file as text plus its sha. Returns { ok: false, ... } if it does not exist.
async function readFile(api, filePath, ref) {
    const url = `${api}/contents/${filePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
    const { res, data } = await ghJson(url);
    if (!res.ok) return { ok: false, status: res.status, message: data.message };
    if (Array.isArray(data)) return { ok: true, isDir: true, entries: data };
    if (data.encoding === 'base64' && data.content) {
        return { ok: true, sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') };
    }
    // Files over 1 MB come back without inline content, so fetch them raw
    const raw = await fetch(url, { headers: ghHeaders('application/vnd.github.raw+json') });
    if (!raw.ok) throw new Error(`GitHub returned ${raw.status} for raw file`);
    return { ok: true, sha: data.sha, text: await raw.text() };
}

async function getFileContents(args) {
    const { owner, repo } = resolveRepo(args);
    const path = args.path || '';
    const api = `https://api.github.com/repos/${owner}/${repo}`;

    const file = await readFile(api, encodePath(path), args.ref);
    if (!file.ok) {
        const hint = file.status === 404 ? ' (wrong path, or GITHUB_PAT cannot access this repo)' : '';
        throw new Error(`GitHub ${file.status} for ${owner}/${repo}:${path} - ${file.message || 'error'}${hint}`);
    }
    if (file.isDir) {
        return JSON.stringify(file.entries.map(e => ({ name: e.name, path: e.path, type: e.type })), null, 2);
    }
    return sliceText(file.text, args);
}

function applyEdits(original, edits) {
    const crlf = original.includes('\r\n');
    const norm = (s) => (crlf ? String(s).replace(/\r?\n/g, '\r\n') : String(s));
    let text = original;
    edits.forEach((e, i) => {
        const label = `edit #${i + 1}`;
        if (typeof e?.find !== 'string' || e.find === '') throw new Error(`${label}: "find" is required`);
        const find = norm(e.find);
        const count = text.split(find).length - 1;
        if (count === 0) throw new Error(`${label}: "find" text not found. It must match the file exactly, including whitespace.`);
        if (count > 1) throw new Error(`${label}: "find" matches ${count} places. Include more surrounding lines so it is unique.`);
        // function form so "$" in Kotlin string templates is not treated as a replace pattern
        text = text.replace(find, () => norm(e.replace ?? ''));
    });
    return text;
}

async function createPullRequest(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const baseBranch = args.base || 'main';
    if (!args.branch) throw new Error('branch is required');

    // Accept either a "files" list (several files in one PR) or the single path/edits/content form
    const files = Array.isArray(args.files) && args.files.length
        ? args.files
        : [{ path: args.path, edits: args.edits, content: args.content }];
    for (const f of files) {
        if (!f?.path) throw new Error('every file needs a path');
        const hasEdits = Array.isArray(f.edits) && f.edits.length > 0;
        if (!hasEdits && typeof f.content !== 'string') throw new Error(`${f.path}: provide either "edits" or "content"`);
    }

    const ref = await ghJson(`${api}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
    if (!ref.res.ok) throw new Error(`Base branch "${baseBranch}": ${ref.data.message || ref.res.status}`);

    const mk = await ghJson(`${api}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: ref.data.object.sha })
    });
    // 422 = branch already exists, which is fine, we just commit onto it
    if (!mk.res.ok && mk.res.status !== 422) throw new Error(`Create branch: ${mk.data.message || mk.res.status}`);

    // Phase 1: work out every new file first, so a bad edit in any file commits nothing
    const planned = [];
    for (const f of files) {
        const filePath = encodePath(f.path);
        const existing = await readFile(api, filePath, args.branch);
        if (existing.ok && existing.isDir) throw new Error(`${f.path} is a directory, not a file`);

        let newContent;
        if (Array.isArray(f.edits) && f.edits.length > 0) {
            if (!existing.ok) throw new Error(`Cannot apply edits: ${f.path} does not exist on ${args.branch}`);
            try {
                newContent = applyEdits(existing.text, f.edits);
            } catch (err) {
                throw new Error(`${f.path}: ${err.message}`);
            }
            if (newContent === existing.text) throw new Error(`${f.path}: the edits produced no change`);
        } else {
            newContent = f.content;
        }
        planned.push({ path: f.path, filePath, newContent, sha: existing.ok ? existing.sha : undefined });
    }

    // Phase 2: commit each file to the branch
    for (const p of planned) {
        const putBody = {
            message: planned.length > 1 ? `${args.commit_message} (${p.path})` : args.commit_message,
            content: Buffer.from(p.newContent, 'utf8').toString('base64'),
            branch: args.branch
        };
        if (p.sha) putBody.sha = p.sha;
        const put = await ghJson(`${api}/contents/${p.filePath}`, { method: 'PUT', body: JSON.stringify(putBody) });
        if (!put.res.ok) throw new Error(`Commit ${p.path}: ${put.data.message || put.res.status}`);
    }

    const pr = await ghJson(`${api}/pulls`, {
        method: 'POST',
        body: JSON.stringify({ title: args.pr_title, body: 'Automated fix by Gemini Spark.', head: args.branch, base: baseBranch })
    });
    if (!pr.res.ok) throw new Error(`Open PR: ${pr.data.message || pr.res.status}`);

    return JSON.stringify({ status: 'PR created', url: pr.data.html_url, number: pr.data.number, files: planned.map(p => p.path) });
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

// Debug from a phone browser: /check?key=SECRET&path=app/src/main/java  (empty path = repo root)
app.get('/check', async (req, res) => {
    if (!isAuthorized(req)) return res.status(401).type('text/plain').send('Unauthorized');
    try {
        if (!GITHUB_PAT) throw new Error('GITHUB_PAT is not set on the server');
        const text = await getFileContents({ path: req.query.path || '' });
        res.type('text/plain').send(text.slice(0, 3000));
    } catch (err) {
        res.status(500).type('text/plain').send(err.message);
    }
});

// This server has no SSE stream, so per the Streamable HTTP spec GET must be 405
app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());

app.post(['/', '/mcp'], async (req, res) => {
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
