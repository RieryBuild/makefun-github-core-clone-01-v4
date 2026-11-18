// Routing, authentication, and the response envelope.
//
// Routes:
//   GET  /healthz                                  -> {"ok": true} (no auth)
//   POST /mcp                                     -> MCP (auth)
//   POST /api/graphql                             -> GraphQL (auth)
//   *    /api/v3/...                              -> REST v3 (auth, except GET /api/v3[/] and /meta)
//   GET  /{owner}/{repo}.git/info/refs            -> smart-HTTP advertisements (no auth)
//   POST /{owner}/{repo}.git/git-upload-pack      -> v2 ls-refs / v2 or v0 fetch (no auth)
//   POST /{owner}/{repo}.git/git-receive-pack     -> v0 push (no auth)
//   *    anything else                            -> 404 {"message": "Not Found"}
//
// Authentication: when MAKEFUN_SHOP_TOKEN is set, the Bearer token must match
// it exactly; when it is unset (local development), any non-empty Bearer is
// accepted; no Authorization header is always a 401. Every response carries a
// non-empty X-GitHub-Request-Id (the transport sets it on structured replies;
// pre-built replies bake a rotating id into their bytes).
//
// Fast paths: the benchmark's hot requests are matched on the raw target
// string before any decoding or segment splitting:
//   - GET /healthz, GET /api/v3[/], GET /api/v3/meta answer from pools of
//     complete pre-built responses (built once at router creation);
//   - GET /repos/{o}/{r}/issues/{n} and POST /repos/{o}/{r}/issues scan the
//     target for owner/repo/number and call the focused REST handlers
//     directly. Any percent-escape in the scanned region, any non-digit tail
//     on the issue number, or any extra segment falls through to the generic
//     dispatch, so the fast paths can never diverge from it.

import { Forge, VIEWER_LOGIN } from './store.ts';
import { createIssueReply, getIssueReply, handleRest, type RestCtx, type RestResult } from './restapi.ts';
import { handleGraphql } from './gql.ts';
import { handleMcp } from './mcpapi.ts';
import {
  decodePktLines,
  firstPushLineOk,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  v0Advertisement,
  v2Advertisement,
} from './gitops.ts';
import { REQUEST_IDS, REQUEST_ID_POOL_SIZE, type Dispatch, type DispatchResult, type InRequest, type OutReply } from './server.ts';

// ---------------------------------------------------------------------------------------------
// constant bodies
// ---------------------------------------------------------------------------------------------

const NOT_FOUND_BODY = Buffer.from('{"message":"Not Found"}', 'utf8');
const UNAUTH_BODY = Buffer.from('{"message":"Requires authentication"}', 'utf8');
const BAD_SERVICE_BODY = Buffer.from('{"message":"Unknown service"}', 'utf8');
const EMPTY_BODY = Buffer.from('{"message":"Empty request"}', 'utf8');
const UNKNOWN_COMMAND_BODY = Buffer.from('{"message":"Unknown command"}', 'utf8');
const MALFORMED_BODY = Buffer.from('{"message":"Malformed request"}', 'utf8');

const HEALTHZ_BODY = Buffer.from('{"ok":true}', 'utf8');
const API_ROOT_BODY = Buffer.from('{"current_user_url":"/api/v3/user","repository_url":"/api/v3/repos/{owner}/{repo}"}', 'utf8');
const META_BODY = Buffer.from('{"installed_version":"1.0.0"}', 'utf8');
const OAUTH_SCOPES: Array<[string, string]> = [['x-oauth-scopes', 'repo, user']];

function jsonReply(status: number, body: Buffer): OutReply {
  return { status, contentType: 'application/json', body };
}

function toReply(result: RestResult): OutReply {
  return {
    status: result.status,
    contentType: 'application/json',
    body: typeof result.body === 'string' ? Buffer.from(result.body, 'utf8') : result.body,
    extra: result.headers,
  };
}

// ---------------------------------------------------------------------------------------------
// static response pools (one complete response per request id, rotating)
// ---------------------------------------------------------------------------------------------

interface StaticPool {
  readonly bufs: readonly Buffer[];
  next: number;
}

function buildStaticPool(statusLine: string, headers: string, body: Buffer): StaticPool {
  const bufs: Buffer[] = new Array(REQUEST_ID_POOL_SIZE);
  for (let i = 0; i < REQUEST_ID_POOL_SIZE; i += 1) {
    const head = `${statusLine}\r\ncontent-type: application/json\r\nx-github-request-id: ${REQUEST_IDS[i]}\r\n${headers}content-length: ${body.length}\r\n\r\n`;
    bufs[i] = Buffer.concat([Buffer.from(head, 'ascii'), body]);
  }
  return { bufs, next: 0 };
}

function nextFromPool(pool: StaticPool): Buffer {
  const buf = pool.bufs[pool.next]!;
  pool.next = (pool.next + 1) & (REQUEST_ID_POOL_SIZE - 1);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function createDispatch(forge: Forge): Dispatch {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN;
  const expectedAuth = expectedToken !== undefined && expectedToken !== '' ? `Bearer ${expectedToken}` : null;

  const healthzPool = buildStaticPool('HTTP/1.1 200 OK', '', HEALTHZ_BODY);
  const apiRootPool = buildStaticPool('HTTP/1.1 200 OK', 'x-oauth-scopes: repo, user\r\n', API_ROOT_BODY);
  const metaPool = buildStaticPool('HTTP/1.1 200 OK', '', META_BODY);

  /** The Bearer token is valid for this request. The exact-match fast path covers every suite call; the trim-and-compare fallback keeps the semantics identical to a full parse. */
  function authenticate(auth: string | null): boolean {
    if (auth === null) return false;
    if (expectedAuth !== null) {
      if (auth === expectedAuth) return true;
      if (!auth.startsWith('Bearer ')) return false;
      return auth.slice(7).trim() === expectedToken;
    }
    if (!auth.startsWith('Bearer ')) return false;
    return auth.slice(7).trim() !== '';
  }

  /**
   * Read one query parameter without building a URLSearchParams: walk the
   * `&`-separated segments and match `name` (bare, meaning '') or `name=value`
   * exactly, so `service` never matches `xservice`. The first occurrence wins,
   * as with URLSearchParams.get. Percent-escapes are decoded only when the
   * value carries one; '+' is left as-is (the values read here never use it).
   */
  function queryParam(queryString: string, name: string): string | null {
    let i = 0;
    while (i <= queryString.length) {
      let end = queryString.indexOf('&', i);
      if (end === -1) end = queryString.length;
      const segment = queryString.slice(i, end);
      if (segment === name) return '';
      if (segment.startsWith(`${name}=`)) {
        const raw = segment.slice(name.length + 1);
        if (raw.indexOf('%') === -1) return raw;
        try {
          return decodeURIComponent(raw);
        } catch {
          return raw;
        }
      }
      i = end + 1;
    }
    return null;
  }

  /** Scan a `/api/v3/repos/{owner}/{repo}/...` target. Returns null when the target does not match, or when any scanned segment carries a percent-escape (fall through to the generic dispatch, which decodes). */
  function scanRepoTarget(target: string): { owner: string; repo: string; restStart: number } | null {
    const PREFIX = '/api/v3/repos/';
    if (!target.startsWith(PREFIX)) return null;
    let i = PREFIX.length;
    const ownerStart = i;
    while (i < target.length && target[i] !== '/') {
      if (target[i] === '%') return null;
      i += 1;
    }
    if (i === ownerStart || i >= target.length) return null;
    const owner = target.slice(ownerStart, i);
    i += 1;
    const repoStart = i;
    while (i < target.length && target[i] !== '/') {
      if (target[i] === '%') return null;
      i += 1;
    }
    if (i === repoStart) return null;
    const repo = target.slice(repoStart, i);
    return { owner, repo, restStart: i };
  }

  /** The GET-issue fast path: GET /api/v3/repos/{o}/{r}/issues/{n} (n = digits only, then end or '?'). */
  function tryGetIssue(req: InRequest): DispatchResult | null {
    const scanned = scanRepoTarget(req.target);
    if (scanned === null) return null;
    const { owner, repo: repoName, restStart } = scanned;
    const target = req.target;
    if (!target.startsWith('/issues/', restStart)) return null;
    let i = restStart + '/issues/'.length;
    const numStart = i;
    while (i < target.length && target[i]! >= '0' && target[i]! <= '9') i += 1;
    if (i === numStart) return null;
    if (i < target.length && target[i] !== '?') return null;
    if (owner !== VIEWER_LOGIN) return jsonReply(404, NOT_FOUND_BODY);
    const repo = forge.getRepo(repoName);
    if (repo === undefined) return jsonReply(404, NOT_FOUND_BODY);
    const number = Number(target.slice(numStart, i));
    const reply = getIssueReply(repo, number);
    return Buffer.isBuffer(reply) ? reply : toReply(reply);
  }

  /** The POST-issue fast path: POST /api/v3/repos/{o}/{r}/issues (then end or '?'). */
  function tryPostIssue(req: InRequest): DispatchResult | null {
    const scanned = scanRepoTarget(req.target);
    if (scanned === null) return null;
    const { owner, repo: repoName, restStart } = scanned;
    const target = req.target;
    if (!target.startsWith('/issues', restStart)) return null;
    const after = restStart + '/issues'.length;
    if (after < target.length && target[after] !== '?') return null;
    if (owner !== VIEWER_LOGIN) return jsonReply(404, NOT_FOUND_BODY);
    const repo = forge.getRepo(repoName);
    if (repo === undefined) return jsonReply(404, NOT_FOUND_BODY);
    return toReply(createIssueReply(forge, repo, req.body));
  }

  function handleGit(req: InRequest, method: string, path: string): DispatchResult {
    // The second path segment must end in '.git' (owner and repo non-empty with
    // no '/' inside either; action non-empty) — the edge cases a plain
    // indexOf('.git/') gets wrong, like a name that itself contains '.git'.
    if (path.charCodeAt(0) !== 47 /* / */) return jsonReply(404, NOT_FOUND_BODY);
    const s1 = path.indexOf('/', 1);
    if (s1 <= 1) return jsonReply(404, NOT_FOUND_BODY);
    const s2 = path.indexOf('/', s1 + 1);
    if (s2 === -1) return jsonReply(404, NOT_FOUND_BODY);
    const segment = path.slice(s1 + 1, s2);
    if (segment.length <= 4 || !segment.endsWith('.git')) return jsonReply(404, NOT_FOUND_BODY);
    const action = path.slice(s2 + 1);
    if (action === '') return jsonReply(404, NOT_FOUND_BODY);
    const owner = path.slice(1, s1);
    const repoName = segment.slice(0, -4);
    if (owner !== VIEWER_LOGIN) return jsonReply(404, NOT_FOUND_BODY);
    const repo = forge.getRepo(repoName);
    if (repo === undefined) return jsonReply(404, NOT_FOUND_BODY);

    if (action === 'info/refs' && method === 'GET') {
      const service = queryParam(req.queryString, 'service');
      if (service === 'git-upload-pack') {
        if (req.gitProtocol === 'version=2') {
          return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
      }
      if (service === 'git-receive-pack') {
        return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
      }
      return jsonReply(400, BAD_SERVICE_BODY);
    }

    if (action === 'git-upload-pack' && method === 'POST') {
      const body = req.body;
      if (body === null || body.length === 0) return jsonReply(400, EMPTY_BODY);
      const { lines } = decodePktLines(body);
      const first = lines[0] ?? '';
      if (req.gitProtocol === 'version=2') {
        if (first.startsWith('command=ls-refs')) {
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, body) };
        }
        if (first.startsWith('command=fetch')) {
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, body) };
        }
        return jsonReply(400, UNKNOWN_COMMAND_BODY);
      }
      if (first.startsWith('want ')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, body) };
      }
      return jsonReply(400, MALFORMED_BODY);
    }

    if (action === 'git-receive-pack' && method === 'POST') {
      const body = req.body;
      if (body === null || body.length === 0) return jsonReply(400, EMPTY_BODY);
      if (!firstPushLineOk(body)) return jsonReply(400, MALFORMED_BODY);
      const { status, body: report } = handleReceivePack(forge, repo, body);
      return { status, contentType: 'application/x-git-receive-pack-result', body: report };
    }

    return jsonReply(404, NOT_FOUND_BODY);
  }

  function handleApiV3(req: InRequest): DispatchResult {
    const { method, path } = req;
    const isPublicRoot = method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
    if (!isPublicRoot && !authenticate(req.auth)) return jsonReply(401, UNAUTH_BODY);
    const body = method === 'GET' || method === 'HEAD' ? null : req.body;
    // Manual segment split: one pass, no intermediate arrays, and
    // decodeURIComponent only for segments that actually carry a percent-escape.
    const rest = path.slice('/api/v3'.length);
    const segments: string[] = [];
    let start = 0;
    for (let i = 0; i <= rest.length; i += 1) {
      if (i === rest.length || rest[i] === '/') {
        if (i > start) {
          const seg = rest.slice(start, i);
          segments.push(seg.indexOf('%') === -1 ? seg : decodeURIComponent(seg));
        }
        start = i + 1;
      }
    }
    const ctx: RestCtx = {
      method,
      segments,
      queryString: req.queryString,
      body,
      host: req.host,
      rawTarget: req.target,
      paramsCache: null,
    };
    return toReply(handleRest(forge, ctx));
  }

  const dispatch: Dispatch = (req: InRequest): DispatchResult => {
    const { method, target, path } = req;

    // Static fast paths (exact raw targets; a query string falls through to
    // the generic dispatch, which answers the same way). HEAD takes the
    // structured form so the transport withholds the body; GET takes the pool.
    if (method === 'GET' || method === 'HEAD') {
      if (target === '/healthz') {
        return method === 'GET' ? nextFromPool(healthzPool) : { status: 200, contentType: 'application/json', body: HEALTHZ_BODY };
      }
      if (target === '/api/v3' || target === '/api/v3/') {
        return method === 'GET'
          ? nextFromPool(apiRootPool)
          : { status: 200, contentType: 'application/json', body: API_ROOT_BODY, extra: OAUTH_SCOPES };
      }
      if (target === '/api/v3/meta') {
        return method === 'GET' ? nextFromPool(metaPool) : { status: 200, contentType: 'application/json', body: META_BODY };
      }
    }

    if (path === '/mcp' && method === 'POST') {
      if (!authenticate(req.auth)) return jsonReply(401, UNAUTH_BODY);
      const result = handleMcp(forge, req.body);
      return { status: result.status, contentType: 'application/json', body: Buffer.from(result.body, 'utf8') };
    }

    if (path === '/api/graphql' && method === 'POST') {
      if (!authenticate(req.auth)) return jsonReply(401, UNAUTH_BODY);
      const result = handleGraphql(forge, req.body);
      return { status: result.status, contentType: 'application/json', body: Buffer.from(result.body, 'utf8') };
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      // Hot REST paths first. Public roots never need auth; the fast paths do
      // (auth precedes the 404, as in the generic dispatch).
      if (method === 'GET' || method === 'POST') {
        const isPublicRoot = method === 'GET' && (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
        if (!isPublicRoot) {
          if (!authenticate(req.auth)) return jsonReply(401, UNAUTH_BODY);
          if (method === 'GET') {
            const fast = tryGetIssue(req);
            if (fast !== null) return fast;
          } else {
            const fast = tryPostIssue(req);
            if (fast !== null) return fast;
          }
        }
      }
      return handleApiV3(req);
    }

    if (path.charCodeAt(0) === 47 /* / */) {
      const git = handleGit(req, method, path);
      // handleGit answers 404 for non-git paths too; that is the same 404 the
      // generic dispatch would return, so it is safe to return directly.
      return git;
    }

    return jsonReply(404, NOT_FOUND_BODY);
  };

  return dispatch;
}
