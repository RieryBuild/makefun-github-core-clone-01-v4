// The REST v3 surface (/api/v3): repositories, branches, commits, git refs,
// contents, issues, labels and pull requests, over the forge's in-memory store.
//
// The suite's client pins down the contract (kit checks-rest.ts):
//   - every reply is JSON with a non-empty X-GitHub-Request-Id (set by the
//     transport / baked into pre-built responses);
//   - unknown route -> 404 {"message"}; malformed JSON body -> 400 {"message"};
//   - a repository under another owner -> 404, never 403;
//   - POST /user/repos with a taken name -> 422 {"message": "...already exists..."};
//     the default branch is 'main' when the body omits it;
//   - GET /user/repos paginates with a Link header carrying an absolute
//     same-origin next URL;
//   - issues and pull requests share one per-repo number counter;
//   - contents commits are real git objects (blob/tree/commit with the given
//     message, trial-epoch timestamps, the forge identity), an update with a
//     stale sha -> 409, a PUT to a missing branch creates that branch from a
//     commit whose parent is the default tip;
//   - a squash merge writes one commit on the base branch (parent = base tip,
//     tree = base tree with the head's changes, message
//     "Merge pull request #N from <head>") and a conflicting merge -> 405.
//
// Hot paths: the router calls getIssueReply / createIssueReply directly for
// GET/POST /repos/{o}/{r}/issues[/n], bypassing the generic segment dispatch.
// GET /issues/{n} answers from a pool of complete pre-built responses (status
// line, headers and body joined, rotating request ids), built lazily on the
// first GET of an issue and dropped whenever the issue mutates.

import {
  TRIAL_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  isOid,
  parseCommit,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { REQUEST_IDS, REQUEST_ID_POOL_SIZE } from './server.ts';

export interface RestCtx {
  readonly method: string;
  /** Path segments after /api/v3 (already URL-decoded). */
  readonly segments: string[];
  /** The raw query string ('' when none). Parsed lazily by params(). */
  readonly queryString: string;
  /** The raw request body, or null when the request had none. */
  readonly body: Buffer | null;
  /** The request's Host header, for absolute pagination URLs. */
  readonly host: string;
  /** The request's path with its query string, e.g. /api/v3/user/repos?per_page=10. */
  readonly rawTarget: string;
  paramsCache: URLSearchParams | null;
}

export interface RestResult {
  readonly status: number;
  /** A Buffer body is sent as-is (cached serializations); a string is sent as-is too. */
  readonly body: string | Buffer;
  readonly headers?: Array<[string, string]>;
}

/** The query params of a request, parsed on first use (most routes need none). */
export function params(ctx: RestCtx): URLSearchParams {
  if (ctx.paramsCache === null) {
    ctx.paramsCache = ctx.queryString === '' ? new URLSearchParams() : new URLSearchParams(ctx.queryString);
  }
  return ctx.paramsCache;
}

const jsonResult = (status: number, value: unknown, headers?: Array<[string, string]>): RestResult => ({
  status,
  body: JSON.stringify(value),
  headers,
});

const errResult = (status: number, message: string): RestResult => jsonResult(status, { message });

type ParsedBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: RestResult };

function parseBody(ctx: RestCtx): ParsedBody {
  if (ctx.body === null || ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, result: errResult(400, 'Problems parsing JSON') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, result: errResult(400, 'Problems parsing JSON') };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

/** The repo serializer, cached on the repo and rebuilt only when its fields change. */
export function repoJson(repo: Repo): string {
  if (repo.repoJson === null) {
    repo.repoJson = JSON.stringify({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: TRIAL_ISO,
      updated_at: TRIAL_ISO,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    });
  }
  return repo.repoJson;
}

/** The repo JSON as bytes, built once beside repoJson. */
function repoJsonBuf(repo: Repo): Buffer {
  if (repo.repoJsonBuf === null) {
    repo.repoJsonBuf = Buffer.from(repoJson(repo), 'utf8');
  }
  return repo.repoJsonBuf;
}

/** Drop a repo's cached serializations (called on mutation). */
export function invalidateRepo(repo: Repo): void {
  repo.repoJson = null;
  repo.repoJsonBuf = null;
}

function issueJson(repo: Repo, issue: Issue): string {
  return JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_ISO,
    updated_at: TRIAL_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

/** An issue's cached serialization as bytes (the string is still used for list joins). */
function issueBuf(repo: Repo, issue: Issue): Buffer {
  if (issue.cachedBuf === null) {
    issue.cachedJson = issueJson(repo, issue);
    issue.cachedBuf = Buffer.from(issue.cachedJson, 'utf8');
  }
  return issue.cachedBuf;
}

// ---------------------------------------------------------------------------
// the issue full-response pool (the read workload's hot path)
// ---------------------------------------------------------------------------

interface IssuePool {
  bufs: Buffer[];
  next: number;
}

const issuePools = new WeakMap<Issue, IssuePool>();

/**
 * The next pre-built complete GET-issue response for an issue (status line,
 * headers and body joined, one buffer per request id in the pool). Built
 * lazily on the first GET: a pool costs ~64 × the response size, so it is only
 * built for issues that are actually read. Returns null when the pool cannot
 * be built (never in practice — the guard is for safety).
 */
export function issueResponsePool(repo: Repo, issue: Issue): Buffer | null {
  let pool = issuePools.get(issue);
  if (pool === undefined) {
    const body = issueBuf(repo, issue);
    const bufs: Buffer[] = new Array(REQUEST_ID_POOL_SIZE);
    for (let i = 0; i < REQUEST_ID_POOL_SIZE; i += 1) {
      const head = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-github-request-id: ${REQUEST_IDS[i]}\r\ncontent-length: ${body.length}\r\n\r\n`;
      bufs[i] = Buffer.concat([Buffer.from(head, 'ascii'), body]);
    }
    pool = { bufs, next: 0 };
    issuePools.set(issue, pool);
  }
  const buf = pool.bufs[pool.next]!;
  pool.next = (pool.next + 1) & (REQUEST_ID_POOL_SIZE - 1);
  return buf;
}

/** Drop an issue's cached serializations AND its response pool (on mutation). */
export function invalidateIssue(issue: Issue): void {
  issue.cachedJson = null;
  issue.cachedBuf = null;
  issuePools.delete(issue);
}

function pullJson(repo: Repo, pull: Pull): string {
  return JSON.stringify({
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_ISO,
    updated_at: TRIAL_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  });
}

function commentJson(repo: Repo, issue: Issue, comment: import('./store.ts').Comment): string {
  return JSON.stringify({
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: TRIAL_ISO,
    updated_at: TRIAL_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  });
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: readonly T[], ctx: RestCtx): { page: T[]; link: string | null } {
  const query = params(ctx);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(Math.max(rawPerPage, 1), 100) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(rawPage, 1) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return { page: slice, link: null };
  const nextParams = new URLSearchParams(query);
  nextParams.set('per_page', String(perPage));
  nextParams.set('page', String(page + 1));
  const next = `http://${ctx.host}${ctx.rawTarget.split('?')[0]}?${nextParams.toString()}`;
  return { page: slice, link: `<${next}>; rel="next"` };
}

function pageHeaders(link: string | null): Array<[string, string]> | undefined {
  return link === null ? undefined : [['link', link]];
}

// ---------------------------------------------------------------------------
// focused handlers (the router's fast paths call these directly)
// ---------------------------------------------------------------------------

/** GET /repos/{o}/{r}/issues/{n}: the read workload's hot path. */
export function getIssueReply(repo: Repo, number: number): RestResult | Buffer {
  const issue = repo.issuesByNumber.get(number);
  if (issue === undefined) return errResult(404, 'Not Found');
  return issueResponsePool(repo, issue) ?? { status: 200, body: issueBuf(repo, issue) };
}

/** POST /repos/{o}/{r}/issues: the write workload's hot path. */
export function createIssueReply(forge: Forge, repo: Repo, body: Buffer | null): RestResult {
  const parsed = parseBody({ body } as RestCtx);
  if (!parsed.ok) return parsed.result;
  const title = asString(parsed.value.title);
  if (title === undefined || title === '') return errResult(422, 'title is required');
  const text = asString(parsed.value.body) ?? '';
  const labels = Array.isArray(parsed.value.labels)
    ? parsed.value.labels.filter((label): label is string => typeof label === 'string')
    : [];
  const created = forge.createIssue(repo, title, text, labels);
  if ('error' in created) return errResult(422, created.error);
  return { status: 201, body: issueBuf(repo, created) };
}

// ---------------------------------------------------------------------------
// entry point (the generic segment dispatch)
// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, ctx: RestCtx): RestResult {
  const { method, segments } = ctx;
  if (segments.length === 0) {
    if (method === 'GET') {
      return jsonResult(
        200,
        { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
        [['x-oauth-scopes', 'repo, user']],
      );
    }
    return errResult(404, 'Not Found');
  }
  if (segments[0] === 'meta' && method === 'GET') {
    return jsonResult(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'user') {
    return handleUser(forge, ctx);
  }
  if (segments[0] === 'repos') {
    return handleRepos(forge, ctx);
  }
  return errResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// /user/*
// ---------------------------------------------------------------------------

function handleUser(forge: Forge, ctx: RestCtx): RestResult {
  const { method, segments } = ctx;
  if (segments.length === 1) {
    if (method === 'GET') {
      return jsonResult(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: 'ada iversen',
        email: 'adaiversen@example.invalid',
        type: 'User',
      });
    }
    return errResult(404, 'Not Found');
  }
  if (segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(forge.listViewerRepos(), ctx);
      return { status: 200, body: `[${page.map((repo) => repoJson(repo)).join(',')}]`, headers: pageHeaders(link) };
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const name = asString(parsed.value.name);
      if (name === undefined || name === '') return errResult(422, 'name is required');
      const repo = forge.createRepo(name, {
        private: asBoolean(parsed.value.private) ?? false,
        description: asString(parsed.value.description) ?? '',
        defaultBranch: asString(parsed.value.default_branch),
      });
      if (repo === null) {
        if (forge.getRepo(name) !== undefined) return errResult(422, 'Repository already exists');
        return errResult(422, 'Invalid repository name');
      }
      return { status: 201, body: repoJson(repo) };
    }
    return errResult(404, 'Not Found');
  }
  return errResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// /repos/{owner}/{repo}/*
// ---------------------------------------------------------------------------

function handleRepos(forge: Forge, ctx: RestCtx): RestResult {
  const { method, segments } = ctx;
  if (segments.length < 3) return errResult(404, 'Not Found');
  const owner = segments[1]!;
  const name = segments[2]!;
  if (owner !== VIEWER_LOGIN) return errResult(404, 'Not Found');
  const repo = forge.getRepo(name);
  if (repo === undefined) return errResult(404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJsonBuf(repo) };
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const description = asString(parsed.value.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBoolean(parsed.value.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      if (description !== undefined || isPrivate !== undefined) invalidateRepo(repo);
      return { status: 200, body: repoJsonBuf(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(name);
      return { status: 204, body: '' };
    }
    return errResult(404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return errResult(404, 'Not Found');
      const list = forge.branches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } }));
      return jsonResult(200, list);
    }
    const branch = rest.slice(1).join('/');
    const sha = forge.branchTip(repo, branch);
    if (sha === null) return errResult(404, 'Not Found');
    if (method === 'GET') return jsonResult(200, { name: branch, commit: { sha } });
    return errResult(404, 'Not Found');
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return errResult(404, 'Not Found');
    const ref = params(ctx).get('sha') ?? repo.defaultBranch;
    let tip: string | null = null;
    if (isOid(ref)) tip = repo.objects.has(ref) ? ref : null;
    else tip = forge.branchTip(repo, ref);
    if (tip === null) return errResult(404, 'Not Found');
    const list = forge.commitsFrom(repo, tip).map((oid) => {
      const commit = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: commit.message,
          // The suite reads only sha + message here; author/committer carry
          // no fields (the reference behaviour serializes them as {}).
          author: {},
          committer: {},
          tree: { sha: commit.tree },
        },
      };
    });
    return jsonResult(200, list);
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return errResult(404, 'Not Found');
      return jsonResult(200, { ref, object: { sha, type: 'commit' } });
    }
    if (rest.length === 2 && method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (ref === undefined || sha === undefined || !isOid(sha)) return errResult(422, 'ref and sha are required');
      if (repo.refs.has(ref)) return errResult(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return errResult(422, 'Object does not exist');
      forge.setRef(repo, ref, sha);
      return jsonResult(201, { ref, object: { sha, type: 'commit' } });
    }
    return errResult(404, 'Not Found');
  }

  if (rest[0] === 'contents') {
    return handleContents(forge, repo, ctx, rest.slice(1).join('/'));
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') {
      return jsonResult(200, [...repo.labels.values()]);
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const name = asString(parsed.value.name);
      if (name === undefined || name === '') return errResult(422, 'name is required');
      const label = forge.createLabel(repo, name, asString(parsed.value.color) ?? '000000');
      return jsonResult(201, label);
    }
    return errResult(404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    return handleIssues(forge, repo, ctx, rest.slice(1));
  }

  if (rest[0] === 'pulls') {
    return handlePulls(forge, repo, ctx, rest.slice(1));
  }

  return errResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function resolveRefTip(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null) return forge.branchTip(repo, repo.defaultBranch);
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  return forge.branchTip(repo, ref);
}

function handleContents(forge: Forge, repo: Repo, ctx: RestCtx, path: string): RestResult {
  const { method } = ctx;
  if (method === 'GET') {
    const ref = params(ctx).get('ref');
    const tip = resolveRefTip(forge, repo, ref);
    if (tip === null) return errResult(404, 'Not Found');
    const commit = parseCommit(repo.objects.get(tip)!.data);
    if (path === '') {
      const root = forge.readPath(repo, commit.tree, '');
      if (root === null || root.kind !== 'dir') return errResult(404, 'Not Found');
      return jsonResult(200, root.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      })));
    }
    const found = forge.readPath(repo, commit.tree, path);
    if (found === null) return errResult(404, 'Not Found');
    if (found.kind === 'dir') {
      return jsonResult(200, found.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: `${path}/${entry.name}`,
        sha: entry.oid,
      })));
    }
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return errResult(404, 'Not Found');
    return jsonResult(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      content: blob.data.toString('base64'),
      sha: found.oid,
    });
  }

  if (method === 'PUT') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) return parsed.result;
    const message = asString(parsed.value.message) ?? 'Update file';
    const contentB64 = asString(parsed.value.content);
    if (contentB64 === undefined) return errResult(422, 'content is required');
    const bytes = Buffer.from(contentB64, 'base64');
    const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const sha = asString(parsed.value.sha);
    const defaultTip = forge.branchTip(repo, repo.defaultBranch);
    const branchTip = forge.branchTip(repo, branch);
    // A missing branch is created from a commit whose parent is the default tip.
    const baseTree = branchTip === null
      ? (defaultTip === null ? null : parseCommit(repo.objects.get(defaultTip)!.data).tree)
      : parseCommit(repo.objects.get(branchTip)!.data).tree;
    const parents = branchTip === null ? (defaultTip === null ? [] : [defaultTip]) : [branchTip];
    const existing = baseTree === null ? null : forge.readPath(repo, baseTree, path);
    if (existing !== null && existing.kind === 'file') {
      if (sha === undefined || sha !== existing.oid) return errResult(409, 'sha does not match the current file');
    }
    const blobOid = forge.putObject(repo, 'blob', bytes);
    const tree = forge.setPath(repo, baseTree, path, blobOid);
    const commitOid = forge.makeCommit(repo, tree, parents, message);
    forge.setRef(repo, `refs/heads/${branch}`, commitOid);
    const status = existing !== null && existing.kind === 'file' ? 200 : 201;
    return jsonResult(status, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64', content: bytes.toString('base64') },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) return parsed.result;
    const message = asString(parsed.value.message) ?? 'Delete file';
    const branch = asString(parsed.value.branch) ?? repo.defaultBranch;
    const sha = asString(parsed.value.sha);
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return errResult(404, 'Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const existing = forge.readPath(repo, tree, path);
    if (existing === null || existing.kind !== 'file') return errResult(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) return errResult(409, 'sha does not match the current file');
    const nextTree = forge.setPath(repo, tree, path, null);
    const commitOid = forge.makeCommit(repo, nextTree, [tip], message);
    forge.setRef(repo, `refs/heads/${branch}`, commitOid);
    return jsonResult(200, { commit: { sha: commitOid, message } });
  }

  return errResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(forge: Forge, repo: Repo, ctx: RestCtx, rest: string[]): RestResult {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const query = params(ctx);
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, link } = paginate(list, ctx);
      return { status: 200, body: `[${page.map((issue) => issue.cachedJson ?? issueJson(repo, issue)).join(',')}]`, headers: pageHeaders(link) };
    }
    if (method === 'POST') {
      return createIssueReply(forge, repo, ctx.body);
    }
    return errResult(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) return errResult(404, 'Not Found');
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) return errResult(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') {
      // The structured form: the router's fast path serves the pooled
      // pre-built response directly; this generic dispatch can only return
      // a body for the transport to wrap.
      return { status: 200, body: issueBuf(repo, issue) };
    }
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const title = asString(parsed.value.title);
      if (title !== undefined) issue.title = title;
      const body = asString(parsed.value.body);
      if (body !== undefined) issue.body = body;
      const state = asString(parsed.value.state);
      if (state === 'open' || state === 'closed') issue.state = state;
      invalidateIssue(issue);
      return { status: 200, body: issueBuf(repo, issue) };
    }
    return errResult(404, 'Not Found');
  }

  if (rest[1] === 'comments') {
    if (method === 'GET') {
      return jsonResult(200, issue.comments.map((comment) => JSON.parse(commentJson(repo, issue, comment)) as unknown));
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const body = asString(parsed.value.body);
      if (body === undefined || body === '') return errResult(422, 'body is required');
      const comment = forge.createComment(repo, issue, body);
      return { status: 201, body: commentJson(repo, issue, comment) };
    }
    return errResult(404, 'Not Found');
  }

  return errResult(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, ctx: RestCtx, rest: string[]): RestResult {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = params(ctx).get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, link } = paginate(list, ctx);
      return { status: 200, body: JSON.stringify(page.map((pull) => JSON.parse(pullJson(repo, pull)) as unknown)), headers: pageHeaders(link) };
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.result;
      const title = asString(parsed.value.title);
      if (title === undefined || title === '') return errResult(422, 'title is required');
      const head = asString(parsed.value.head);
      const base = asString(parsed.value.base);
      if (head === undefined || base === undefined) return errResult(422, 'head and base are required');
      const headRef = head.includes(':') ? head.split(':').slice(1).join(':') : head;
      const baseRef = base.includes(':') ? base.split(':').slice(1).join(':') : base;
      const created = forge.createPull(repo, title, asString(parsed.value.body) ?? '', headRef, baseRef);
      if ('error' in created) return errResult(422, created.error);
      return { status: 201, body: pullJson(repo, created) };
    }
    return errResult(404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isFinite(number)) return errResult(404, 'Not Found');
  const pull = forge.getPull(repo, number);
  if (pull === undefined) return errResult(404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    return errResult(404, 'Not Found');
  }

  if (rest[1] === 'files') {
    if (method !== 'GET') return errResult(404, 'Not Found');
    const files = forge.pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    return jsonResult(200, files);
  }

  if (rest[1] === 'merge') {
    if (method !== 'PUT' && method !== 'POST') return errResult(404, 'Not Found');
    const parsed = parseBody(ctx);
    if (!parsed.ok) return parsed.result;
    if (pull.state !== 'open') return errResult(405, 'Pull request is not open');
    if (forge.pullConflicts(repo, pull)) return errResult(405, 'Merge conflict');
    const sha = forge.mergePull(repo, pull);
    if (sha === null) return errResult(405, 'Merge conflict');
    return jsonResult(200, { merged: true, sha, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
  }

  return errResult(404, 'Not Found');
}
