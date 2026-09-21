import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

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
        annotations: { title: 'Read file', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
        name: 'search_code',
        annotations: { title: 'Search code', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Regex search across all text source files of the repo (like grep -rn). Returns "path:line: text". Use it to find where something is defined or used BEFORE reading files. Combine several terms in one call with |, for example "SmartImage|AsyncImage". Optional include narrows to paths containing a substring.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                pattern: { type: 'string', description: 'Regular expression, case-insensitive by default' },
                include: { type: 'string', description: 'Only search paths containing this text, e.g. "presentation/" or ".xml"' },
                context: { type: 'integer', description: 'Lines of context around each match (0-3)' },
                max_results: { type: 'integer', description: 'Maximum matches (default 100)' },
                ref: { type: 'string', description: 'Optional branch or commit (default branch if omitted)' }
            },
            required: ['pattern']
        }
    },
    {
        name: 'commit_files',
        annotations: { title: 'Commit files to a branch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Commits changes to one or more files directly to an EXISTING branch as a single commit, with no pull request. Use "files": a list of {path, edits} where each edit is a {find, replace} snippet (each "find" must match exactly once). Committing to the default branch (main) only works if the server owner enabled it; otherwise use create_pull_request.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                branch: { type: 'string', description: 'Existing branch to commit to, for example main' },
                files: {
                    type: 'array',
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
                commit_message: { type: 'string' }
            },
            required: ['branch', 'files', 'commit_message']
        }
    },
    {
        name: 'run_workflow',
        annotations: { title: 'Start a build', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description: 'Starts a GitHub Actions workflow run (default: "Manual Test Build") on a branch. Returns the run_id. Then call get_build_status with wait_seconds=40 until it completes.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                workflow: { type: 'string', description: 'Workflow name, file name or id. Defaults to "Manual Test Build".' },
                ref: { type: 'string', description: 'Branch to run on (default branch if omitted)' },
                inputs: { type: 'object', description: 'Optional workflow_dispatch inputs' }
            }
        }
    },
    {
        name: 'get_build_status',
        annotations: { title: 'Check build status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Shows the status of a workflow run (latest run if run_id is omitted), with its jobs and failed steps. Set wait_seconds (max 40) to wait for it to finish before answering.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                run_id: { type: 'integer' },
                workflow: { type: 'string', description: 'Only look at runs of this workflow' },
                branch: { type: 'string', description: 'Only look at runs on this branch' },
                wait_seconds: { type: 'integer', description: 'Wait up to this many seconds (max 40) for the run to complete' }
            }
        }
    },
    {
        name: 'get_build_log',
        annotations: { title: 'Read build errors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Reads the log of a FAILED run (the latest failed run if run_id is omitted) and returns the key compile errors with file paths and line numbers, plus the last lines. Use pattern (regex) or tail (line count) for a different view.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                run_id: { type: 'integer' },
                branch: { type: 'string', description: 'Latest failed run on this branch' },
                pattern: { type: 'string', description: 'Regex to search the log for' },
                tail: { type: 'integer', description: 'Return only the last N lines' }
            }
        }
    },
    {
        name: 'preview_bulk_rename',
        annotations: { title: 'Preview a repo-wide rename', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'DRY RUN of a repo-wide package/text rename. Rules {find, replace} are applied to file contents (dotted form) and to file paths (dotted and slash form, so folders move). Changes nothing. Returns counts, folders that would move, config-file lines that would change, and lines that mention words you list in also_report. Rules run in order.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                base: { type: 'string', description: 'Branch to read (default branch if omitted)' },
                replacements: {
                    type: 'array',
                    items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] }
                },
                skip_paths: { type: 'array', items: { type: 'string' }, description: 'Leave files whose path contains any of these untouched, for example "app/build.gradle.kts"' },
                also_report: { type: 'array', items: { type: 'string' }, description: 'Words to list if they still appear after the rename' }
            },
            required: ['replacements']
        }
    },
    {
        name: 'apply_bulk_rename',
        annotations: { title: 'Apply a repo-wide rename', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Applies the same rename as preview_bulk_rename on a NEW branch as one commit (files are moved by reference, nothing is retyped) and opens a pull request. Run preview_bulk_rename first.',
        inputSchema: {
            type: 'object',
            properties: {
                owner: { type: 'string' },
                repo: { type: 'string' },
                base: { type: 'string', description: 'Branch to start from (default branch if omitted)' },
                branch: { type: 'string', description: 'NEW branch name to create' },
                replacements: {
                    type: 'array',
                    items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] }
                },
                skip_paths: { type: 'array', items: { type: 'string' } },
                commit_message: { type: 'string' },
                pr_title: { type: 'string' },
                open_pr: { type: 'boolean', description: 'Open a pull request (default true)' }
            },
            required: ['branch', 'replacements']
        }
    },
    {
        name: 'create_pull_request',
        annotations: { title: 'Create pull request', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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

// ---------- Repo-wide search (like grep -rn) ----------
const TEXT_EXT = /\.(kt|kts|java|xml|gradle|json|md|toml|properties|pro|txt|yml|yaml|cfg|aidl|proto|html|js|sh|bat|cmake|cpp|h)$/i;
const SKIP_DIR = /(^|\/)(build|\.gradle|\.git|node_modules)\//;
const MAX_FILE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_CHARS = 60 * 1000 * 1000;
let repoCache = null; // { key, time, files: [{ path, lines }] }

function parsePax(buf) {
    const out = {};
    let i = 0;
    while (i < buf.length) {
        const sp = buf.indexOf(0x20, i);
        if (sp < 0) break;
        const len = parseInt(buf.toString('ascii', i, sp), 10);
        if (!len) break;
        const rec = buf.toString('utf8', sp + 1, i + len - 1);
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
    }
    return out;
}

// Streams a .tar.gz from GitHub and collects the text source files
async function loadRepoFiles(owner, repo, ref) {
    const key = `${owner}/${repo}@${ref || 'default'}`;
    if (repoCache && repoCache.key === key && Date.now() - repoCache.time < CACHE_TTL_MS) return repoCache.files;

    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const res = await fetch(`${api}/tarball${ref ? '/' + encodePath(ref) : ''}`, { headers: ghHeaders() });
    if (!res.ok || !res.body) throw new Error(`GitHub ${res.status} while downloading the repo archive`);

    const it = Readable.fromWeb(res.body).pipe(zlib.createGunzip())[Symbol.asyncIterator]();
    let buf = Buffer.alloc(0), ended = false;
    const fill = async (n) => {
        while (buf.length < n && !ended) {
            const { value, done } = await it.next();
            if (done) ended = true; else buf = Buffer.concat([buf, value]);
        }
    };
    const read = async (n) => { await fill(n); const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };
    const skip = async (n) => {
        while (n > 0) {
            if (!buf.length) { await fill(1); if (!buf.length) return; }
            const k = Math.min(n, buf.length);
            buf = buf.subarray(k); n -= k;
        }
    };

    const files = [];
    let chars = 0, paxPath = null;
    while (true) {
        const h = await read(512);
        if (h.length < 512 || h.every(b => b === 0)) break;
        let name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
        if (h.toString('ascii', 257, 262) === 'ustar') {
            const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
            if (prefix) name = `${prefix}/${name}`;
        }
        const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
        const type = String.fromCharCode(h[156]);
        const padded = Math.ceil(size / 512) * 512;

        if (type === 'x' || type === 'g' || type === 'L') {
            const data = (await read(padded)).subarray(0, size);
            if (type === 'x') { const p = parsePax(data).path; if (p) paxPath = p; }
            if (type === 'L') paxPath = data.toString('utf8').replace(/\0.*$/, '');
            continue;
        }
        const fullPath = paxPath || name;
        paxPath = null;
        const path = fullPath.split('/').slice(1).join('/'); // drop the "owner-repo-sha/" prefix

        if ((type === '0' || type === '\0') && TEXT_EXT.test(path) && !SKIP_DIR.test(path) && size <= MAX_FILE_BYTES) {
            const text = (await read(padded)).subarray(0, size).toString('utf8');
            chars += text.length;
            files.push({ path, lines: text.split('\n') });
        } else {
            await skip(padded);
        }
    }
    if (chars <= CACHE_MAX_CHARS) repoCache = { key, time: Date.now(), files };
    return files;
}

async function searchCode(args) {
    const { owner, repo } = resolveRepo(args);
    if (!args.pattern) throw new Error('pattern is required');
    if (String(args.pattern).length > 300) throw new Error('pattern is too long');
    let re;
    try { re = new RegExp(args.pattern, args.ignore_case === false ? '' : 'i'); }
    catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

    const ctx = Math.min(Math.max(parseInt(args.context, 10) || 0, 0), 3);
    const maxResults = Math.min(Math.max(parseInt(args.max_results, 10) || 100, 1), 300);
    const include = args.include ? String(args.include).toLowerCase() : '';

    const files = await loadRepoFiles(owner, repo, args.ref);
    const out = [];
    let matches = 0, filesHit = 0, size = 0, truncated = false;

    outer:
    for (const f of files) {
        if (include && !f.path.toLowerCase().includes(include)) continue;
        let hitThisFile = false;
        for (let i = 0; i < f.lines.length; i++) {
            if (!re.test(f.lines[i])) continue;
            if (matches >= maxResults || size > MAX_CHARS) { truncated = true; break outer; }
            if (!hitThisFile) { hitThisFile = true; filesHit++; }
            matches++;
            const from = Math.max(0, i - ctx), to = Math.min(f.lines.length - 1, i + ctx);
            for (let j = from; j <= to; j++) {
                const line = `${f.path}:${j + 1}${j === i ? ':' : '-'} ${f.lines[j].replace(/\r$/, '').slice(0, 220)}`;
                out.push(line);
                size += line.length + 1;
            }
            if (ctx) out.push('--');
        }
    }
    const header = `[${matches} match(es) in ${filesHit} file(s); searched ${files.length} text files${truncated ? '; RESULTS TRUNCATED, narrow the pattern or set include' : ''}]`;
    return matches ? `${header}\n${out.join('\n')}` : `${header}\nNo matches.`;
}

// Works out the new content of every file (applies edits) without committing anything
async function planFiles(api, files, branch) {
    const planned = [];
    for (const f of files) {
        const filePath = encodePath(f.path);
        const existing = await readFile(api, filePath, branch);
        if (existing.ok && existing.isDir) throw new Error(`${f.path} is a directory, not a file`);

        let newContent;
        if (Array.isArray(f.edits) && f.edits.length > 0) {
            if (!existing.ok) throw new Error(`Cannot apply edits: ${f.path} does not exist on ${branch}`);
            try {
                newContent = applyEdits(existing.text, f.edits);
            } catch (err) {
                throw new Error(`${f.path}: ${err.message}`);
            }
            if (newContent === existing.text) throw new Error(`${f.path}: the edits produced no change`);
        } else {
            if (typeof f.content !== 'string') throw new Error(`${f.path}: provide either "edits" or "content"`);
            newContent = f.content;
        }
        planned.push({ path: f.path, filePath, newContent, sha: existing.ok ? existing.sha : undefined });
    }
    return planned;
}

// Commits changes straight to an EXISTING branch as ONE commit (no pull request)
async function commitFiles(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    if (!args.branch) throw new Error('branch is required');
    if (!args.commit_message) throw new Error('commit_message is required');
    if (!Array.isArray(args.files) || !args.files.length) throw new Error('files is required');
    for (const f of args.files) if (!f?.path) throw new Error('every file needs a path');

    const info = await ghJson(api);
    if (!info.res.ok) throw new Error(`Repo: ${info.data.message || info.res.status}`);
    if (args.branch === info.data.default_branch && process.env.ALLOW_MAIN_COMMITS !== 'true') {
        throw new Error(`Direct commits to "${args.branch}" are disabled on this server. Use create_pull_request, or ask the owner to set ALLOW_MAIN_COMMITS=true.`);
    }

    const ref = await ghJson(`${api}/git/ref/heads/${encodePath(args.branch)}`);
    if (!ref.res.ok) throw new Error(`Branch "${args.branch}" not found (use create_pull_request to make a new branch)`);
    const headSha = ref.data.object.sha;
    const head = await ghJson(`${api}/git/commits/${headSha}`);
    if (!head.res.ok) throw new Error(`Read head commit: ${head.data.message || head.res.status}`);

    const planned = await planFiles(api, args.files, args.branch);

    const tree = await ghJson(`${api}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
            base_tree: head.data.tree.sha,
            tree: planned.map(p => ({ path: p.path.replace(/^\/+/, ''), mode: '100644', type: 'blob', content: p.newContent }))
        })
    });
    if (!tree.res.ok) throw new Error(`Create tree: ${tree.data.message || tree.res.status}`);

    const commit = await ghJson(`${api}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message: args.commit_message, tree: tree.data.sha, parents: [headSha] })
    });
    if (!commit.res.ok) throw new Error(`Create commit: ${commit.data.message || commit.res.status}`);

    const upd = await ghJson(`${api}/git/refs/heads/${encodePath(args.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.data.sha, force: false })
    });
    if (!upd.res.ok) throw new Error(`Update branch: ${upd.data.message || upd.res.status}`);

    return JSON.stringify({
        status: 'committed', branch: args.branch, sha: commit.data.sha,
        url: `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
        files: planned.map(p => p.path)
    });
}

// ---------- GitHub Actions (build) tools ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DEFAULT_WORKFLOW = process.env.DEFAULT_WORKFLOW || 'Manual Test Build';

async function resolveWorkflow(api, wanted) {
    const key = String(wanted || DEFAULT_WORKFLOW).trim().toLowerCase();
    const { res, data } = await ghJson(`${api}/actions/workflows?per_page=100`);
    if (!res.ok) throw new Error(`List workflows: ${data.message || res.status}`);
    const list = data.workflows || [];
    const base = (p) => p.split('/').pop().toLowerCase();
    const hit = list.find(w => String(w.id) === key)
        || list.find(w => w.name.toLowerCase() === key)
        || list.find(w => base(w.path) === key || base(w.path).replace(/\.ya?ml$/, '') === key);
    if (!hit) {
        throw new Error(`Workflow "${wanted || DEFAULT_WORKFLOW}" not found. Available: ${list.map(w => `"${w.name}" (${w.path})`).join(', ') || 'none'}`);
    }
    return hit;
}

const runSummary = (r) => ({
    run_id: r.id, workflow: r.name, status: r.status, conclusion: r.conclusion,
    branch: r.head_branch, commit: (r.head_sha || '').slice(0, 7), created: r.created_at, url: r.html_url
});

async function runWorkflow(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const wf = await resolveWorkflow(api, args.workflow);

    let ref = args.ref;
    if (!ref) {
        const info = await ghJson(api);
        if (!info.res.ok) throw new Error(`Repo: ${info.data.message || info.res.status}`);
        ref = info.data.default_branch;
    }

    const startedAt = Date.now();
    const disp = await fetch(`${api}/actions/workflows/${wf.id}/dispatches`, {
        method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref, inputs: args.inputs || {} })
    });
    if (disp.status !== 204) {
        const d = await disp.json().catch(() => ({}));
        const hint = [404, 422].includes(disp.status) ? ' (check the branch name, that the workflow has a workflow_dispatch trigger on it, and any required inputs)' : '';
        throw new Error(`Dispatch "${wf.name}" on ${ref}: ${d.message || disp.status}${hint}`);
    }

    // dispatch returns no run id, so look for the run that just appeared
    for (let i = 0; i < 8; i++) {
        await sleep(2000);
        const { res, data } = await ghJson(`${api}/actions/workflows/${wf.id}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=5`);
        const run = res.ok && (data.workflow_runs || []).find(r => Date.parse(r.created_at) >= startedAt - 30000);
        if (run) {
            return JSON.stringify({ status: 'started', ...runSummary(run), next: 'Call get_build_status with this run_id and wait_seconds=40 until it completes.' });
        }
    }
    return JSON.stringify({ status: 'dispatched', workflow: wf.name, ref, note: 'Run not visible yet. Call get_build_status in a few seconds.' });
}

async function getRun(api, args) {
    if (args.run_id) {
        const { res, data } = await ghJson(`${api}/actions/runs/${encodeURIComponent(args.run_id)}`);
        if (!res.ok) throw new Error(`Run ${args.run_id}: ${data.message || res.status}`);
        return data;
    }
    let base = `${api}/actions/runs`;
    if (args.workflow) base = `${api}/actions/workflows/${(await resolveWorkflow(api, args.workflow)).id}/runs`;
    let url = `${base}?per_page=5`;
    if (args.branch) url += `&branch=${encodeURIComponent(args.branch)}`;
    if (args.status) url += `&status=${encodeURIComponent(args.status)}`;
    const { res, data } = await ghJson(url);
    if (!res.ok) throw new Error(`List runs: ${data.message || res.status}`);
    const run = (data.workflow_runs || [])[0];
    if (!run) throw new Error('No matching workflow runs found');
    return run;
}

async function getJobs(api, runId) {
    const { data } = await ghJson(`${api}/actions/runs/${runId}/jobs?per_page=30`);
    return data.jobs || [];
}

async function getBuildStatus(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    let run = await getRun(api, args);

    const wait = Math.min(Math.max(parseInt(args.wait_seconds, 10) || 0, 0), 40);
    const deadline = Date.now() + wait * 1000;
    while (run.status !== 'completed' && Date.now() < deadline) {
        await sleep(4000);
        run = await getRun(api, { run_id: run.id });
    }

    const jobs = (await getJobs(api, run.id)).map(j => ({
        id: j.id, name: j.name, status: j.status, conclusion: j.conclusion,
        failed_steps: (j.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name),
        current_step: j.status === 'in_progress' ? (j.steps || []).find(s => s.status === 'in_progress')?.name : undefined
    }));
    const hint = run.status !== 'completed' ? 'Still running. Call again with wait_seconds=40.'
        : run.conclusion === 'success' ? 'Build passed.'
        : 'Build did not pass. Call get_build_log to see the errors.';
    return JSON.stringify({ ...runSummary(run), jobs, hint }, null, 2);
}

// GitHub masks secret values in logs as ***, which can hide part of a file path.
// Rebuild those paths by matching them against the real files in the repo.
async function unmaskPaths(lines, owner, repo, ref) {
    if (!lines.some(l => l.includes('***'))) return lines;
    let files;
    try { files = await loadRepoFiles(owner, repo, ref); } catch { return lines; }
    const paths = files.map(f => f.path);
    const memo = new Map();
    const resolve = (tok) => {
        if (memo.has(tok)) return memo.get(tok);
        const re = new RegExp('^' + tok.split('***').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
        const m = paths.filter(p => re.test(p));
        const out = m.length === 1 ? m[0] : tok;
        memo.set(tok, out);
        return out;
    };
    return lines.map(l => l.replace(/[\w./*-]*\*\*\*[\w./*-]*\.(?:kt|kts|java|xml|gradle)\b/g, resolve));
}

const LOG_TS = /^\ufeff?\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const LOG_ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const LOG_ERR = /(^|\s)e: |##\[error\]|FAILURE:|What went wrong|Execution failed|Caused by:|\berror:|> Task \S+ FAILED|Unresolved reference|Exception\b/;

async function getBuildLog(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const run = await getRun(api, args.run_id ? args : { ...args, status: args.status || 'failure' });
    if (run.status !== 'completed') return JSON.stringify({ ...runSummary(run), hint: 'This run is not finished yet. Use get_build_status with wait_seconds=40.' });

    const jobs = await getJobs(api, run.id);
    let targets = jobs.filter(j => j.conclusion === 'failure');
    if (!targets.length) targets = jobs.filter(j => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
    if (!targets.length) return JSON.stringify({ ...runSummary(run), hint: 'No failed jobs in this run.' });

    const out = [`[run ${run.id} on ${run.head_branch} @ ${(run.head_sha || '').slice(0, 7)}: ${run.conclusion}]`];
    for (const job of targets.slice(0, 2)) {
        const lr = await fetch(`${api}/actions/jobs/${job.id}/logs`, { headers: ghHeaders() });
        if (!lr.ok) throw new Error(`Job log ${lr.status} (does the token have Actions read access?)`);
        const lines = (await lr.text()).split('\n').map(l =>
            l.replace(LOG_TS, '').replace(LOG_ANSI, '').replace(/\r$/, '')
             .replace(/file:\/\/\/home\/runner\/work\/[^/]+\/[^/]+\//g, ''));

        const failedSteps = (job.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name).join(', ');
        out.push(`--- job "${job.name}"${failedSteps ? `, failed step: ${failedSteps}` : ''} (${lines.length} log lines) ---`);

        if (args.pattern) {
            let re;
            try { re = new RegExp(args.pattern, 'i'); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }
            let n = 0;
            for (let i = 0; i < lines.length && n < 80; i++) {
                if (re.test(lines[i])) { n++; out.push(`${i + 1}: ${lines[i].slice(0, 300)}`); }
            }
            if (!n) out.push('No lines matched.');
        } else if (args.tail) {
            const t = Math.min(Math.max(parseInt(args.tail, 10) || 40, 1), 300);
            lines.slice(-t).forEach(l => out.push(l.slice(0, 300)));
        } else {
            const keep = new Set();
            lines.forEach((l, i) => {
                if (/^w: /.test(l) || !LOG_ERR.test(l)) return;
                keep.add(i);
                if (/What went wrong/.test(l)) for (let k = 1; k <= 3; k++) keep.add(i + k);
            });
            out.push('KEY ERRORS:');
            [...keep].filter(i => i < lines.length).slice(0, 60).forEach(i => out.push(`${i + 1}: ${lines[i].slice(0, 300)}`));
            if (!keep.size) out.push('(no error lines recognised, see the tail below)');
            out.push('LAST 25 LINES:');
            lines.slice(-25).forEach(l => out.push(l.slice(0, 300)));
        }
    }
    const fixed = await unmaskPaths(out, owner, repo, run.head_branch);
    let text = fixed.join('\n');
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n[output truncated, use pattern or tail to narrow]';
    return text;
}

// ---------- Bulk rename (package rename across the whole repo, done server-side) ----------
// Each rule {find, replace} is applied to file CONTENTS (dotted form only, so URLs like
// github.com/name are never touched) and to file PATHS (dotted form and slash form, so the
// folders move too). Files are moved by reusing their git blob, so nothing is retyped.
function pathVariants(find, replace) {
    const pairs = [[find, replace]];
    const f2 = find.replace(/\./g, '/'), r2 = replace.replace(/\./g, '/');
    if (f2 !== find) pairs.push([f2, r2]);
    return pairs;
}
function applyPathRules(path, reps) {
    let p = path;
    for (const { find, replace } of reps) for (const [f, r] of pathVariants(find, replace)) p = p.split(f).join(r);
    return p;
}
function applyContentRules(text, reps) {
    let t = text;
    for (const { find, replace } of reps) if (t.includes(find)) t = t.split(find).join(replace);
    return t;
}

async function planBulkRename(args) {
    const { owner, repo } = resolveRepo(args);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const reps = (Array.isArray(args.replacements) ? args.replacements : [])
        .filter(r => r && typeof r.find === 'string' && r.find && typeof r.replace === 'string');
    if (!reps.length) throw new Error('replacements is required: a list of {find, replace}, for example {"find":"com.old","replace":"com.new"}');
    const skip = (Array.isArray(args.skip_paths) ? args.skip_paths : []).map(String).filter(Boolean);

    let base = args.base;
    if (!base) {
        const info = await ghJson(api);
        if (!info.res.ok) throw new Error(`Repo: ${info.data.message || info.res.status}`);
        base = info.data.default_branch;
    }
    const ref = await ghJson(`${api}/git/ref/heads/${encodePath(base)}`);
    if (!ref.res.ok) throw new Error(`Base branch "${base}": ${ref.data.message || ref.res.status}`);
    const headSha = ref.data.object.sha;
    const head = await ghJson(`${api}/git/commits/${headSha}`);
    if (!head.res.ok) throw new Error(`Read head commit: ${head.data.message || head.res.status}`);
    const treeSha = head.data.tree.sha;
    const tree = await ghJson(`${api}/git/trees/${treeSha}?recursive=1`);
    if (!tree.res.ok) throw new Error(`Read file list: ${tree.data.message || tree.res.status}`);
    if (tree.data.truncated) throw new Error('The repo file list is too large for this tool');
    const entries = tree.data.tree.filter(e => e.type === 'blob');
    const existing = new Set(entries.map(e => e.path));

    const files = await loadRepoFiles(owner, repo, base);
    const textByPath = new Map(files.map(f => [f.path, f]));

    const changes = [];
    const targets = new Set();
    for (const e of entries) {
        if (e.mode === '120000' || e.mode === '160000') continue; // symlinks and submodules
        if (skip.some(s => e.path.includes(s))) continue;
        const newPath = applyPathRules(e.path, reps);
        const tf = textByPath.get(e.path);
        let newText = null;
        if (tf) {
            const old = tf.lines.join('\n');
            const t = applyContentRules(old, reps);
            if (t !== old) newText = t;
        }
        if (newPath === e.path && newText === null) continue;
        if (newPath !== e.path && existing.has(newPath)) throw new Error(`Collision: ${e.path} would move onto the existing file ${newPath}`);
        if (targets.has(newPath)) throw new Error(`Collision: two files would both become ${newPath}`);
        targets.add(newPath);
        changes.push({ path: e.path, newPath, mode: e.mode, sha: e.sha, newText });
    }
    return { owner, repo, api, reps, base, headSha, treeSha, changes, textByPath, skip };
}

async function previewBulkRename(args) {
    const plan = await planBulkRename(args);
    const { changes, textByPath, reps } = plan;
    const moved = changes.filter(c => c.newPath !== c.path);
    const edited = changes.filter(c => c.newText !== null);

    const dirPairs = new Map();
    for (const c of moved) {
        const od = c.path.split('/').slice(0, -1).join('/'), nd = c.newPath.split('/').slice(0, -1).join('/');
        if (!dirPairs.has(od)) dirPairs.set(od, nd);
    }
    const isSrc = (p) => /\.(kt|java)$/.test(p);
    const config = [], literals = [];
    for (const c of edited) {
        const lines = textByPath.get(c.path).lines;
        let perFile = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (!reps.some(r => line.includes(r.find))) continue;
            if (!isSrc(c.path)) { if (perFile++ < 3) config.push(`${c.path}:${i + 1}: ${line.slice(0, 200)}`); }
            else if (!/^\s*(package|import|@file:)/.test(line)) literals.push(`${c.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
    }
    const leftovers = [];
    const words = (Array.isArray(args.also_report) ? args.also_report : []).map(String).filter(Boolean);
    if (words.length) {
        const changed = new Map(changes.map(c => [c.path, c.newText]));
        for (const [p, f] of textByPath) {
            if (plan.skip.some(s => p.includes(s))) continue;
            const text = changed.get(p) ?? null;
            const lines = text !== null ? text.split('\n') : f.lines;
            for (let i = 0; i < lines.length && leftovers.length < 40; i++) {
                if (words.some(w => lines[i].includes(w))) leftovers.push(`${p}:${i + 1}: ${lines[i].replace(/\r$/, '').trim().slice(0, 200)}`);
            }
        }
    }

    const out = [
        `[PREVIEW on ${plan.base} @ ${plan.headSha.slice(0, 7)}. Nothing was changed.]`,
        `files with edited contents: ${edited.length}`,
        `files that would move to a new path: ${moved.length}`,
        `folders that move (old -> new, first 12 of ${dirPairs.size}):`,
        ...[...dirPairs].slice(0, 12).map(([o, n]) => `  ${o} -> ${n}`),
        `NON-Kotlin/Java files whose contents change (check these, for example applicationId, authorities, workflow paths):`,
        ...(config.length ? config.slice(0, 50) : ['  none']),
        `Kotlin/Java lines that are NOT package/import lines (string literals, comments):`,
        ...(literals.length ? literals.slice(0, 30) : ['  none']),
    ];
    if (words.length) out.push(`STILL CONTAINS ${words.map(w => `"${w}"`).join(', ')} after the rename (left as is):`, ...(leftovers.length ? leftovers : ['  none']));
    let text = out.join('\n');
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n[output truncated]';
    return text;
}

async function applyBulkRename(args) {
    if (!args.branch) throw new Error('branch is required: the NEW branch to create');
    const plan = await planBulkRename(args);
    if (!plan.changes.length) throw new Error('Nothing to change: no file matched the replacements');
    const { api, changes } = plan;

    const mk = await ghJson(`${api}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: plan.headSha }) });
    if (!mk.res.ok) throw new Error(`Create branch "${args.branch}": ${mk.data.message || mk.res.status} (use a branch name that does not exist yet)`);

    try {
        const entries = [];
        for (const c of changes) {
            if (c.newPath !== c.path) entries.push({ path: c.path, mode: c.mode, type: 'blob', sha: null }); // delete old path
            entries.push(c.newText !== null
                ? { path: c.newPath, mode: c.mode, type: 'blob', content: c.newText }
                : { path: c.newPath, mode: c.mode, type: 'blob', sha: c.sha });
        }

        // build the new tree in small batches, each one on top of the previous
        let baseTree = plan.treeSha, batch = [], bytes = 0;
        const flush = async () => {
            if (!batch.length) return;
            const t = await ghJson(`${api}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: batch }) });
            if (!t.res.ok) throw new Error(`Create tree: ${t.data.message || t.res.status}`);
            baseTree = t.data.sha; batch = []; bytes = 0;
        };
        for (const e of entries) {
            batch.push(e);
            bytes += e.content ? Buffer.byteLength(e.content) : 200;
            if (batch.length >= 80 || bytes > 3000000) await flush();
        }
        await flush();

        const message = args.commit_message || 'Rename packages';
        const commit = await ghJson(`${api}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: baseTree, parents: [plan.headSha] }) });
        if (!commit.res.ok) throw new Error(`Create commit: ${commit.data.message || commit.res.status}`);
        const upd = await ghJson(`${api}/git/refs/heads/${encodePath(args.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.data.sha, force: false }) });
        if (!upd.res.ok) throw new Error(`Update branch: ${upd.data.message || upd.res.status}`);

        const result = {
            status: 'renamed', branch: args.branch, commit: commit.data.sha.slice(0, 7),
            files_edited: changes.filter(c => c.newText !== null).length,
            files_moved: changes.filter(c => c.newPath !== c.path).length
        };
        if (args.open_pr !== false) {
            const pr = await ghJson(`${api}/pulls`, {
                method: 'POST',
                body: JSON.stringify({ title: args.pr_title || message, body: 'Automated package rename.', head: args.branch, base: plan.base })
            });
            if (!pr.res.ok) throw new Error(`Open PR: ${pr.data.message || pr.res.status}`);
            result.pr_url = pr.data.html_url;
        }
        return JSON.stringify(result);
    } catch (err) {
        throw new Error(`${err.message}. The branch "${args.branch}" was created but may be incomplete: use a different branch name for the next try.`);
    }
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

    const ref = await ghJson(`${api}/git/ref/heads/${encodePath(baseBranch)}`);
    if (!ref.res.ok) throw new Error(`Base branch "${baseBranch}": ${ref.data.message || ref.res.status}`);

    const mk = await ghJson(`${api}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: ref.data.object.sha })
    });
    // 422 = branch already exists, which is fine, we just commit onto it
    if (!mk.res.ok && mk.res.status !== 422) throw new Error(`Create branch: ${mk.data.message || mk.res.status}`);

    // Phase 1: work out every new file first, so a bad edit in any file commits nothing
    const planned = await planFiles(api, files, args.branch);

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
                    else if (name === 'search_code') text = await searchCode(args);
                    else if (name === 'commit_files') text = await commitFiles(args);
                    else if (name === 'run_workflow') text = await runWorkflow(args);
                    else if (name === 'get_build_status') text = await getBuildStatus(args);
                    else if (name === 'get_build_log') text = await getBuildLog(args);
                    else if (name === 'preview_bulk_rename') text = await previewBulkRename(args);
                    else if (name === 'apply_bulk_rename') text = await applyBulkRename(args);
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
    
