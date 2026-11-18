// A minimal HTTP/1.1 server over node:net, built for this forge's workload.
//
// The dispatch is fully synchronous and every request is small, so node:http's
// machinery (IncomingMessage/ServerResponse objects, async stream events,
// chunked encoding) is pure overhead. This server parses one request at a time
// from the socket buffer, hands the complete request to the (synchronous)
// dispatch, and writes the response as a single buffer with an explicit
// Content-Length. Keep-alive and pipelining are supported; chunked request
// bodies are decoded (the suite sends Content-Length, but a client could in
// principle send chunked).
//
// Header parsing is targeted, not general: the dispatch only ever needs a
// handful of headers (authorization, content-length, connection, git-protocol,
// host, expect, transfer-encoding), so the parser scans the header block for
// those names instead of splitting every line into a record. The header block
// is lowercased once for the search; values are sliced from the original, so
// casing is preserved where it matters (the Bearer token).
//
// Responses take two forms. A structured reply is built here (status line +
// headers + body, one write). A bare Buffer is a complete pre-built response
// (status line, headers and body already joined) that goes straight to the
// socket with zero per-request work — the read workload's hot GET uses those.
// Pre-built replies are only ever produced for GET routes; HEAD requests get
// the structured form so the body can be withheld.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';

/** One fully-parsed request, in transport-neutral form. The body is complete. */
export interface InRequest {
  method: string;
  /** The request target as received (path + query). */
  target: string;
  /** Decoded pathname (percent-escapes decoded, like URL.pathname). */
  path: string;
  /** The raw query string ('' when the target has none). */
  queryString: string;
  /** The Authorization header value, or null when absent. */
  auth: string | null;
  /** The Git-Protocol header value, or null when absent. */
  gitProtocol: string | null;
  /** The Host header value ('' when absent). */
  host: string;
  /** False when the connection must close after this response. */
  keepAlive: boolean;
  /** The complete body, or null when the request had none (or an empty one). */
  body: Buffer | null;
  /** Lazily parsed query params, filled by the router on first use. */
  queryParams: URLSearchParams | null;
}

/** A structured reply: the transport builds the status line and headers. */
export interface OutReply {
  status: number;
  contentType: string;
  body: Buffer;
  extra?: Array<[string, string]>;
}

/** What the dispatch returns: a structured reply, or a complete pre-built response. */
export type DispatchResult = OutReply | Buffer;

export type Dispatch = (req: InRequest) => DispatchResult;

const MAX_HEADERS_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Chunked trailers are discarded, but a client may not stream them forever. */
const MAX_TRAILER_BYTES = 8 * 1024;

const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

// ---------------------------------------------------------------------------
// request ids
// ---------------------------------------------------------------------------

/**
 * The request-id pool: 64 ids, fixed for the life of the process, handed out
 * round-robin. The contract requires a non-empty X-GitHub-Request-Id on every
 * reply; it does not require uniqueness, and rotating ids keep consecutive
 * replies distinct while letting hot paths pre-build whole responses (the id
 * is baked into the bytes). Structured replies take the next id from the same
 * pool, so ids rotate across both reply forms.
 */
const ID_POOL_SIZE = 64;
export const REQUEST_IDS: readonly string[] = (() => {
  const pidHex = process.pid.toString(16);
  const ids: string[] = new Array(ID_POOL_SIZE);
  for (let i = 0; i < ID_POOL_SIZE; i += 1) ids[i] = `req-${pidHex}-${i.toString(16).padStart(8, '0')}`;
  return ids;
})();
export const REQUEST_ID_POOL_SIZE = ID_POOL_SIZE;

let nextId = 0;
export function nextRequestId(): string {
  const id = REQUEST_IDS[nextId]!;
  nextId = (nextId + 1) & (ID_POOL_SIZE - 1);
  return id;
}

// ---------------------------------------------------------------------------
// header scanning
// ---------------------------------------------------------------------------

interface HeadScan {
  method: string;
  target: string;
  version: string;
  auth: string | null;
  gitProtocol: string | null;
  host: string;
  connection: string;
  expectContinue: boolean;
  chunked: boolean;
  contentLength: number;
}

/**
 * Find a header's value in the head block. `lower` is the lowercased head (for
 * the name search); `orig` is the original (values are sliced from it, so the
 * offsets line up: lowercasing a latin1 string never changes its length).
 * Returns the trimmed value, or null when the header is absent.
 */
function headerValue(lower: string, orig: string, name: string): string | null {
  const needle = `\r\n${name}:`;
  const at = lower.indexOf(needle);
  if (at === -1) return null;
  const valueStart = at + needle.length;
  let end = orig.indexOf('\r\n', valueStart);
  if (end === -1) end = orig.length;
  let value = orig.slice(valueStart, end);
  // Trim ASCII whitespace (space/tab) from both ends.
  let s = 0;
  let e = value.length;
  while (s < e && (value.charCodeAt(s) === 32 || value.charCodeAt(s) === 9)) s += 1;
  while (e > s && (value.charCodeAt(e - 1) === 32 || value.charCodeAt(e - 1) === 9)) e -= 1;
  return value.slice(s, e);
}

/** Parse the request line + the headers the dispatch needs. Null when malformed. */
function scanHead(headText: string): HeadScan | null {
  const firstEol = headText.indexOf('\r\n');
  const requestLine = firstEol === -1 ? headText : headText.slice(0, firstEol);
  const sp1 = requestLine.indexOf(' ');
  if (sp1 <= 0) return null;
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp2 === -1 || sp2 === requestLine.length - 1) return null;
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (target === '' || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) return null;
  // The request line itself must not contain a third space.
  if (requestLine.indexOf(' ', sp2 + 1) !== -1) return null;

  const lower = headText.toLowerCase();
  const auth = headerValue(lower, headText, 'authorization');
  const gitProtocol = headerValue(lower, headText, 'git-protocol');
  const host = headerValue(lower, headText, 'host') ?? '';
  const connection = headerValue(lower, headText, 'connection') ?? '';
  const expect = headerValue(lower, headText, 'expect');
  const transferEncoding = headerValue(lower, headText, 'transfer-encoding');
  const contentLengthText = headerValue(lower, headText, 'content-length');
  let contentLength = 0;
  if (contentLengthText !== null) {
    contentLength = Number.parseInt(contentLengthText, 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) return null;
    if (contentLength > MAX_BODY_BYTES) return null;
  }
  return {
    method,
    target,
    version,
    auth,
    gitProtocol,
    host,
    connection,
    expectContinue: expect !== null && expect.toLowerCase() === '100-continue',
    chunked: transferEncoding !== null && transferEncoding.toLowerCase().includes('chunked'),
    contentLength,
  };
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

const BAD_REQUEST_BYTES = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: 23\r\n\r\n{"message":"Bad Request"}',
  'ascii',
);
const CONTINUE_BYTES = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

export function createTransportServer(dispatch: Dispatch): NetServer {
  return createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf: Buffer = Buffer.alloc(0);
    let head: HeadScan | null = null;
    let bodyLen = 0;
    let chunked = false;
    let chunks: Buffer[] = [];
    let chunkedBytes = 0;
    let trailerBytes = 0;
    let chunkMode: 'size' | 'data' | 'trailer' = 'size';
    let chunkLeft = 0;

    socket.on('error', () => socket.destroy());

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      try {
        parseLoop();
      } catch {
        // A malformed request line or chunk framing: answer 400 and close,
        // matching what node:http would do for a request it cannot parse.
        if (!socket.destroyed) socket.write(BAD_REQUEST_BYTES);
        socket.end();
      }
    });

    function parseLoop(): void {
      for (;;) {
        if (head === null) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) {
            if (buf.length > MAX_HEADERS_BYTES) socket.destroy();
            return;
          }
          const parsed = scanHead(buf.subarray(0, end).toString('latin1'));
          if (parsed === null) throw new Error('malformed request line');
          buf = buf.subarray(end + 4);
          head = parsed;
          if (head.expectContinue) {
            if (!socket.destroyed) socket.write(CONTINUE_BYTES);
          }
          if (head.chunked) {
            chunked = true;
            chunks = [];
            chunkedBytes = 0;
            trailerBytes = 0;
            chunkMode = 'size';
            chunkLeft = 0;
          } else {
            bodyLen = head.contentLength;
          }
        }

        if (chunked) {
          const done = consumeChunked();
          if (!done) return;
          const body = chunks.length === 0 ? null : Buffer.concat(chunks);
          const current = head;
          head = null;
          chunked = false;
          respond(current, body);
          continue;
        }

        if (buf.length < bodyLen) return;
        const body = bodyLen === 0 ? null : buf.subarray(0, bodyLen);
        buf = buf.subarray(bodyLen);
        const current = head;
        head = null;
        respond(current, body);
        // Loop: a pipelined next request may already be buffered.
      }
    }

    /** Consume as much of the chunked body as is buffered. Returns true when complete. */
    function consumeChunked(): boolean {
      for (;;) {
        if (chunkMode === 'size') {
          const eol = buf.indexOf('\r\n');
          if (eol === -1) return false;
          const sizeText = buf.subarray(0, eol).toString('latin1').trim().split(';')[0]!;
          const size = Number.parseInt(sizeText, 16);
          if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
          buf = buf.subarray(eol + 2);
          if (size === 0) {
            chunkMode = 'trailer';
            continue;
          }
          chunkedBytes += size;
          if (chunkedBytes > MAX_BODY_BYTES) {
            socket.destroy();
            return false;
          }
          chunkLeft = size;
          chunkMode = 'data';
        }
        if (chunkMode === 'data') {
          if (buf.length < chunkLeft + 2) return false;
          chunks.push(buf.subarray(0, chunkLeft));
          buf = buf.subarray(chunkLeft + 2);
          chunkMode = 'size';
        }
        if (chunkMode === 'trailer') {
          const eol = buf.indexOf('\r\n');
          if (eol === -1) return false;
          if (eol === 0) {
            buf = buf.subarray(2);
            return true;
          }
          trailerBytes += eol + 2;
          if (trailerBytes > MAX_TRAILER_BYTES) {
            socket.destroy();
            return false;
          }
          buf = buf.subarray(eol + 2);
        }
      }
    }

    function respond(current: HeadScan, body: Buffer | null): void {
      const target = current.target;
      const q = target.indexOf('?');
      const rawPath = q === -1 ? target : target.slice(0, q);
      const queryString = q === -1 ? '' : target.slice(q + 1);
      let path: string;
      if (rawPath.indexOf('%') === -1) {
        path = rawPath;
      } else {
        try {
          path = decodeURIComponent(rawPath);
        } catch {
          path = rawPath;
        }
      }
      const keepAlive =
        current.version === 'HTTP/1.1'
          ? current.connection.toLowerCase() !== 'close'
          : current.connection.toLowerCase() === 'keep-alive';
      let result: DispatchResult;
      try {
        result = dispatch({
          method: current.method,
          target,
          path,
          queryString,
          auth: current.auth,
          gitProtocol: current.gitProtocol,
          host: current.host,
          keepAlive,
          body,
          queryParams: null,
        });
      } catch (err) {
        console.error('request error:', err instanceof Error ? err.message : err);
        result = {
          status: 500,
          contentType: 'application/json',
          body: Buffer.from('{"message":"Internal Server Error"}', 'utf8'),
        };
      }
      if (Buffer.isBuffer(result)) {
        // A complete pre-built response: one write, nothing to build.
        if (!socket.destroyed) socket.write(result);
      } else {
        const reason = REASONS[result.status] ?? 'OK';
        let headText = `HTTP/1.1 ${result.status} ${reason}\r\ncontent-type: ${result.contentType}\r\nx-github-request-id: ${nextRequestId()}\r\n`;
        if (result.extra !== undefined) {
          for (const [name, value] of result.extra) headText += `${name}: ${value}\r\n`;
        }
        headText += `content-length: ${result.body.length}\r\n\r\n`;
        // HEAD responses carry the headers (and the would-be Content-Length) but no body.
        if (current.method === 'HEAD' || result.body.length === 0) {
          if (!socket.destroyed) socket.write(headText, 'ascii');
        } else {
          if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from(headText, 'ascii'), result.body]));
        }
      }
      if (!keepAlive) socket.end();
    }
  });
}
