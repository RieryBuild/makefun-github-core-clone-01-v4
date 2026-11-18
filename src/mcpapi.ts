// The MCP surface (POST /mcp): Streamable HTTP, JSON-RPC 2.0, no session handshake.
//
// The suite pins down (checks-mcp.ts):
//   - the modern era: `server/discover` returns {supportedVersions:
//     ['2026-07-28','2025-11-25'], capabilities: {tools: {}}, serverInfo:
//     {name, version}} (the serverInfo also under
//     _meta['io.modelcontextprotocol/serverInfo']); the legacy era (initialize +
//     notifications/initialized) is the fallback and is implemented too.
//   - tools/list returns >= 6 tools, byte-identical across calls (the list is
//     built once at module load from the spec table below).
//   - every tool result carries BOTH content:[{type:'text', text: JSON of the
//     result}] and structuredContent: <result>.
//   - an unknown tool -> JSON-RPC -32601, never HTTP 500; a malformed JSON body
//     -> HTTP 400 with JSON-RPC -32700 and id null; missing required arguments
//     -> an isError:true result.
//   - a notification (no id) -> 202 with an empty body.
//   - authentication is decided by the router before this module runs (401
//     without a valid Bearer).

import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'] as const;

// ---------------------------------------------------------------------------------------------
// the tool catalogue: a compact spec table, expanded once at module load
// ---------------------------------------------------------------------------------------------

type ToolSpec = readonly [
  name: string,
  description: string,
  properties: ReadonlyArray<readonly [prop: string, type: string, description: string]>,
  required: readonly string[],
];

const TOOL_SPECS: readonly ToolSpec[] = [
  [
    'create_repo',
    'Create a repository owned by the authenticated user.',
    [
      ['name', 'string', 'The repository name.'],
      ['description', 'string', 'A short description of the repository.'],
      ['private', 'boolean', 'Whether the repository is private.'],
    ],
    ['name'],
  ],
  [
    'get_repo',
    'Get a repository by owner and name.',
    [
      ['owner', 'string', 'The repository owner login.'],
      ['repo', 'string', 'The repository name.'],
    ],
    ['owner', 'repo'],
  ],
  [
    'create_issue',
    'Create an issue in a repository.',
    [
      ['owner', 'string', 'The repository owner login.'],
      ['repo', 'string', 'The repository name.'],
      ['title', 'string', 'The issue title.'],
      ['body', 'string', 'The issue body.'],
    ],
    ['owner', 'repo', 'title'],
  ],
  [
    'list_issues',
    'List the issues of a repository, optionally filtered by state.',
    [
      ['owner', 'string', 'The repository owner login.'],
      ['repo', 'string', 'The repository name.'],
      ['state', 'string', 'open, closed, or all.'],
    ],
    ['owner', 'repo'],
  ],
  [
    'create_pull_request',
    'Create a pull request from a head branch onto a base branch.',
    [
      ['owner', 'string', 'The repository owner login.'],
      ['repo', 'string', 'The repository name.'],
      ['title', 'string', 'The pull request title.'],
      ['head', 'string', 'The head branch name.'],
      ['base', 'string', 'The base branch name.'],
      ['body', 'string', 'The pull request body.'],
    ],
    ['owner', 'repo', 'title', 'head', 'base'],
  ],
  [
    'merge_pull_request',
    'Squash-merge a pull request onto its base branch.',
    [
      ['owner', 'string', 'The repository owner login.'],
      ['repo', 'string', 'The repository name.'],
      ['pull_number', 'integer', 'The pull request number.'],
    ],
    ['owner', 'repo', 'pull_number'],
  ],
];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: readonly string[];
  };
}

/** The tools/list payload, built once: the list must be byte-identical across calls. */
const TOOLS: readonly ToolDef[] = TOOL_SPECS.map(([name, description, properties, required]) => ({
  name,
  description,
  inputSchema: {
    type: 'object' as const,
    properties: Object.fromEntries(properties.map(([prop, type, desc]) => [prop, { type, description: desc }])),
    required,
  },
}));

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

const DISCOVER_RESULT = {
  supportedVersions: [...SUPPORTED_VERSIONS],
  capabilities: { tools: {} },
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
};

// ---------------------------------------------------------------------------------------------
// tool implementations (the same forge operations as REST/GraphQL)
// ---------------------------------------------------------------------------------------------

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new Error(`Missing required argument: ${name}`);
  return value;
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = requireString(args, 'owner');
  const repoName = requireString(args, 'repo');
  if (owner !== VIEWER_LOGIN) throw new Error('Not Found');
  const repo = forge.getRepo(repoName);
  if (repo === undefined) throw new Error('Not Found');
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      const repo = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      // An invalid name and a taken name both surface the same message.
      if (repo === null) throw new Error('Repository already exists');
      return repoObject(repo);
    }
    case 'get_repo': {
      return repoObject(findRepo(forge, args));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      const title = requireString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      const created = forge.createIssue(repo, title, body, []);
      if ('error' in created) throw new Error(created.error);
      return { id: created.id, number: created.number, title: created.title, body: created.body, state: created.state, labels: [] };
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      const body = typeof args.body === 'string' ? args.body : '';
      const created = forge.createPull(repo, title, body, head, base);
      if ('error' in created) throw new Error(created.error);
      return {
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      };
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      const pullNumber = args.pull_number;
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
        throw new Error('Missing required argument: pull_number');
      }
      const pull = forge.getPull(repo, pullNumber);
      if (pull === undefined) throw new Error('Not Found');
      if (pull.state !== 'open') throw new Error('Pull request is not open');
      const sha = forge.mergePull(repo, pull);
      if (sha === null) throw new Error('Merge conflict');
      return { merged: true, sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------------------------

interface McpResult {
  readonly status: number;
  readonly body: string;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function handleRequest(forge: Forge, request: unknown): McpResult {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const envelope = request as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in envelope;
  if (typeof envelope.method !== 'string') {
    return hasId ? rpcError(envelope.id ?? null, -32600, 'Invalid Request') : { status: 202, body: '' };
  }
  if (!hasId) {
    // A notification (the initialize handshake, a cancellation, ...): acknowledge, no body.
    return { status: 202, body: '' };
  }
  const { id, method } = envelope;
  if (method === 'server/discover') {
    return rpcResult(id, DISCOVER_RESULT);
  }
  if (method === 'initialize') {
    const requested = (envelope.params as Record<string, unknown> | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : '2025-11-25';
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const args = (envelope.params ?? {}) as Record<string, unknown>;
    const toolName = args.name;
    if (typeof toolName !== 'string') return rpcError(id, -32602, 'Invalid params: name is required');
    if (!TOOL_NAMES.has(toolName)) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
    const toolArgs = (args.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = callTool(forge, toolName, toolArgs);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (err) {
      return rpcResult(id, {
        content: [{ type: 'text', text: err instanceof Error ? err.message : 'Tool error' }],
        isError: true,
      });
    }
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Handle one MCP request body (a single JSON-RPC message, or a batch array). */
export function handleMcp(forge: Forge, body: Buffer | null): McpResult {
  if (body === null || body.length === 0) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const request of parsed) {
      const result = handleRequest(forge, request);
      if (result.status !== 202) responses.push(JSON.parse(result.body) as unknown);
    }
    return { status: 200, body: JSON.stringify(responses) };
  }
  return handleRequest(forge, parsed);
}
