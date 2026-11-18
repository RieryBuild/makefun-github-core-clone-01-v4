// The git smart-HTTP surface: protocol v2 upload-pack (advertisement, ls-refs,
// fetch) and v0 receive-pack (advertisement, push), over the forge's in-memory
// objects and refs.
//
// Wire notes the suite's client pins down (kit git-client.ts):
//   - v2 advertisement: `# service=...` preamble, flush, `version 2`, capability
//     lines, flush. Capabilities the client needs: ls-refs=unborn,
//     fetch=shallow, agent, object-format=sha1.
//   - v0 advertisement: `# service=...` preamble, flush, `<oid> <ref>\0<caps>`
//     first line, the ref lines, peeled `^{}` lines for annotated tags, flush.
//     Empty repo: the zero id with the `capabilities^{}` pseudo-ref.
//     Receive-pack must advertise report-status, side-band-64k and delete-refs;
//     upload-pack must advertise side-band-64k (else a fetch cannot be framed).
//   - v2 fetch answers sections: acknowledgments (NAK), shallow-info when a depth
//     is asked for, then packfile with sideband band-1 packets. v0 fetch answers
//     NAK, shallow lines, then the sideband pack. A fetch with nothing new still
//     answers a packfile section carrying an empty (0-entry) pack.
//   - receive-pack answers the report-status stream inside sideband band 1:
//     `unpack ok`, then one `ok <ref>` / `ng <ref> <reason>` line per command,
//     in command order. A non-fast-forward refusal is exactly
//     `ng <ref> non-fast-forward` and the ref does not move; the pack's objects
//     are stored even when a ref is refused.
//
// Performance notes:
//   - The v0 advertisement is built from a per-repo TEMPLATE: its shape depends
//     only on the ref NAMES (which change rarely), so the template is cached on
//     refNamesVersion and each request only copies it and splices the current
//     tip oids into their slots. A push moves a tip every time but never changes
//     the ref set, so the advertisement stays a ~300-byte copy plus two 40-byte
//     writes. (When a ref points at an annotated tag the peeled line's
//     existence depends on the tip, so that case falls back to a fresh build.)
//   - Fetch packs and ls-refs answers are cached on (repo version, raw request
//     body): the clone workload's 50 identical clones share one pack build.
//   - The receive-pack path parses the command pkt-lines directly out of the
//     body buffer instead of going through the generic decoder: no regex, no
//     intermediate string array for the pack bytes.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type Forge,
  type GitObject,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function hexVal(byte: number): number {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 97 && byte <= 102) return byte - 87;
  if (byte >= 65 && byte <= 70) return byte - 55;
  return -1;
}

/** Read a 4-hex pkt-line length at `offset`; -1 when the bytes are not hex. */
function pktLenAt(body: Buffer, offset: number): number {
  if (offset + 4 > body.length) return -1;
  const a = hexVal(body[offset]!);
  const b = hexVal(body[offset + 1]!);
  const c = hexVal(body[offset + 2]!);
  const d = hexVal(body[offset + 3]!);
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1;
  return (a << 12) | (b << 8) | (c << 4) | d;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH_PKT: Buffer = Buffer.from('0000', 'ascii');
export const DELIM_PKT: Buffer = Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item === 'flush') parts[i] = FLUSH_PKT;
    else if (item === 'delim') parts[i] = DELIM_PKT;
    else parts[i] = pktLine(item);
  }
  return Buffer.concat(parts);
}

/** Decode a whole body into pkt-line payloads (data packets only, in order). */
export function decodePktLines(body: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = pktLenAt(body, offset);
    if (length === -1) break;
    if (length === 0) {
      offset += 4;
      lines.push('\u0000flush');
      continue;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      lines.push('\u0000delim');
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    lines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { lines, rest: body.subarray(offset) };
}

// ---------------------------------------------------------------------------
// response caches
// ---------------------------------------------------------------------------

interface AdTemplate {
  /** The ref-names generation this template was built for. */
  namesVersion: number;
  /** The advertisement with ZERO_OID in every oid slot. */
  buf: Buffer;
  /** Slot offsets + what fills them: a ref name (its tip), or '' for HEAD. */
  slots: Array<{ offset: number; ref: string; peeled: boolean }>;
  /** When slots is empty the template IS the answer (no copy needed). */
  fixed: Buffer | null;
}

interface RepoCaches {
  fetchV2: Map<string, Buffer>;
  fetchV0: Map<string, Buffer>;
  lsRefs: Map<string, Buffer>;
  adUp: AdTemplate | null;
  adRecv: AdTemplate | null;
}

const MAX_CACHE_ENTRIES = 128;

const repoCaches = new WeakMap<Repo, RepoCaches>();

function cachesFor(repo: Repo): RepoCaches {
  let caches = repoCaches.get(repo);
  if (caches === undefined) {
    caches = { fetchV2: new Map(), fetchV0: new Map(), lsRefs: new Map(), adUp: null, adRecv: null };
    repoCaches.set(repo, caches);
  }
  return caches;
}

function cacheSet(map: Map<string, Buffer>, key: string, value: Buffer): void {
  if (map.size >= MAX_CACHE_ENTRIES) map.clear();
  map.set(key, value);
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly symrefTarget?: string;
  readonly unborn?: boolean;
}

/** Every ref line of a repo, HEAD first, then refs in name order, with peeled tags. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef) ?? null;
  if (defaultTip !== null) {
    lines.push({ oid: defaultTip, name: 'HEAD', symrefTarget: defaultRef });
  } else {
    lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

/** Follow a tag chain to its commit, or null when it does not end at one. */
function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** The v2 capability advertisement (info/refs with Git-Protocol: version=2).
    It never varies, so it is built once and shared. */
const V2_ADVERTISEMENT: Buffer = pktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'agent=forge/1.0\n',
  'object-format=sha1\n',
  'flush',
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=forge/1.0';

/**
 * Build a v0 advertisement template for one service: the full advertisement
 * with ZERO_OID in every oid slot, plus the slot table. The shape depends only
 * on the ref names (and which refs peel), so the template is keyed on
 * refNamesVersion. Returns null when a ref tip is an annotated tag (the peeled
 * line's existence would depend on the tip) — the caller builds fresh then.
 */
function buildAdTemplate(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): AdTemplate | null {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const all = refLines(repo);
  const lines = all.filter((line) => line.name !== 'HEAD');
  const headLine = all.find((line) => line.name === 'HEAD')!;
  // A peeled line exists only when the tip peels to a commit; a repoint could
  // change that without changing the ref names, so tag tips disqualify the
  // template (rare: the suite's refs point at commits).
  for (const line of lines) {
    const object = repo.objects.get(line.oid);
    if (object !== undefined && object.type === 'tag') return null;
  }
  let buf = Buffer.allocUnsafe(1024);
  let pos = 0;
  const slots: Array<{ offset: number; ref: string; peeled: boolean }> = [];
  const ensure = (need: number): void => {
    if (pos + need <= buf.length) return;
    let size = buf.length;
    while (pos + need > size) size *= 2;
    const next = Buffer.allocUnsafe(size);
    buf.copy(next, 0, 0, pos);
    buf = next;
  };
  const writePkt = (text: string, slotRef: string | null, peeled: boolean): void => {
    const len = Buffer.byteLength(text, 'utf8') + 4;
    ensure(len);
    buf.write(len.toString(16).padStart(4, '0'), pos, 4, 'ascii');
    pos += 4;
    if (slotRef !== null) slots.push({ offset: pos, ref: slotRef, peeled });
    pos += buf.write(text, pos, 'utf8');
  };
  const writeFlush = (): void => {
    ensure(4);
    buf.write('0000', pos, 4, 'ascii');
    pos += 4;
  };
  writePkt(`# service=${service}\n`, null, false);
  writeFlush();
  if (lines.length === 0) {
    // An empty repository: the zero id with the capabilities pseudo-ref.
    writePkt(`${ZERO_OID} capabilities^{}\u0000${caps} ${symref}\n`, null, false);
  } else {
    writePkt(`${ZERO_OID} HEAD\u0000${caps} ${symref}\n`, '', false);
    for (const line of lines) {
      writePkt(`${ZERO_OID} ${line.name}\n`, line.name, false);
      if (line.peeled !== undefined) writePkt(`${ZERO_OID} ${line.name}^{}\n`, line.name, true);
    }
  }
  void headLine;
  writeFlush();
  const body = buf.subarray(0, pos);
  return {
    namesVersion: repo.refNamesVersion,
    buf: body,
    slots,
    fixed: slots.length === 0 ? body : null,
  };
}

/** A v0 ref advertisement for one service, from the cached template. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caches = cachesFor(repo);
  let template = service === 'git-upload-pack' ? caches.adUp : caches.adRecv;
  if (template === null || template.namesVersion !== repo.refNamesVersion) {
    template = buildAdTemplate(repo, service);
    if (service === 'git-upload-pack') caches.adUp = template;
    else caches.adRecv = template;
    if (template === null) return buildAdFresh(repo, service);
  }
  if (template.fixed !== null) return template.fixed;
  const out = Buffer.from(template.buf);
  for (const slot of template.slots) {
    let oid: string;
    if (slot.ref === '') {
      // HEAD: the default branch tip, or zero when the branch is unborn.
      oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
    } else {
      const tip = repo.refs.get(slot.ref) ?? ZERO_OID;
      oid = slot.peeled ? (peelTag(repo, tip) ?? tip) : tip;
    }
    out.write(oid, slot.offset, 40, 'ascii');
  }
  return out;
}

/** The slow path: build a v0 advertisement from scratch (tag tips only). */
function buildAdFresh(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const all = refLines(repo);
  const lines = all.filter((line) => line.name !== 'HEAD');
  const headLine = all.find((line) => line.name === 'HEAD')!;
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (lines.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps} ${symref}\n`);
  } else {
    const headOid = headLine.unborn === true ? ZERO_OID : headLine.oid;
    items.push(`${headOid} HEAD\u0000${caps} ${symref}\n`);
    for (const line of lines) {
      items.push(`${line.oid} ${line.name}\n`);
      if (line.peeled !== undefined) items.push(`${line.peeled} ${line.name}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  // Key on the raw body: the same bytes always mean the same args, and latin1
  // is a plain byte-to-char map (no UTF-8 validation) for this ASCII wire
  // format. Parsing happens only on a cache miss.
  const cacheKey = `${repo.version}|${body.toString('latin1')}`;
  const cached = cachesFor(repo).lsRefs.get(cacheKey);
  if (cached !== undefined) return cached;
  const { lines } = decodePktLines(body);
  const prefixes: string[] = [];
  let unborn = false;
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    else if (text === 'unborn') unborn = true;
  }
  const out: string[] = [];
  const all = refLines(repo);
  for (const line of all) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    if (line.unborn === true) {
      if (unborn) out.push(`unborn ${line.name}${line.symrefTarget !== undefined ? ` symref-target:${line.symrefTarget}` : ''}\n`);
      continue;
    }
    let text = `${line.oid} ${line.name}`;
    if (line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    out.push(`${text}\n`);
  }
  const response = pktLines([...out, 'flush']);
  cacheSet(cachesFor(repo).lsRefs, cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2FetchArgs(body: Buffer): FetchArgs {
  const { lines } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function parseV0FetchArgs(body: Buffer): FetchArgs {
  const { lines } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const line of lines) {
    if (line === '\u0000flush') {
      seenFlush = true;
      continue;
    }
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      args.wants.push(rest.split(' ')[0]!);
    } else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    } else if (seenFlush && text.startsWith('have ')) {
      args.haves.push(text.slice(5).trim());
    }
  }
  return args;
}

/** The objects a fetch must send, and the shallow-info lines for a depth request. */
function planFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the closure of its haves, stopping at its
  // shallow boundaries (a shallow clone holds a boundary commit and its tree,
  // not the boundary's parents).
  const held = collectReachable(args.haves, lookup, { stopAt: new Set(args.shallow) }).objects;
  const { objects, shallow } = collectReachable(args.wants, lookup, args.depth === null ? {} : { maxGeneration: args.depth });
  const packObjects: Array<{ type: GitObject['type']; data: Buffer }> = [];
  for (const oid of objects) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) packObjects.push(object);
  }
  const pack = writePack(packObjects);
  const unshallow: string[] = [];
  if (args.depth !== null) {
    for (const old of args.shallow) {
      if (objects.has(old) && !shallow.includes(old)) unshallow.push(old);
    }
  }
  return { pack, shallow: args.depth === null ? [] : shallow, unshallow };
}

/**
 * Split pack bytes into sideband band-1 pkt-lines (32 KiB of data each),
 * built into ONE buffer: the frame sizes are known up front, so no per-chunk
 * concat is needed.
 */
function sidebandPack(pack: Buffer): Buffer {
  const CHUNK = 32768;
  if (pack.length === 0) return Buffer.alloc(0);
  const chunks = Math.ceil(pack.length / CHUNK);
  let total = 0;
  for (let i = 0; i < chunks; i += 1) {
    const len = Math.min(CHUNK, pack.length - i * CHUNK);
    total += 4 + 1 + len;
  }
  const out = Buffer.allocUnsafe(total);
  let pos = 0;
  for (let i = 0; i < chunks; i += 1) {
    const start = i * CHUNK;
    const len = Math.min(CHUNK, pack.length - start);
    out.write((len + 5).toString(16).padStart(4, '0'), pos, 4, 'ascii');
    pos += 4;
    out[pos] = 1;
    pos += 1;
    pack.copy(out, pos, start, start + len);
    pos += len;
  }
  return out;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  // Key on the raw body (same bytes = same args) so a cache hit skips the parse.
  const cacheKey = `${repo.version}|${body.toString('latin1')}`;
  const cached = cachesFor(repo).fetchV2.get(cacheKey);
  if (cached !== undefined) return cached;
  const args = parseV2FetchArgs(body);
  const { pack, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM_PKT];
  if (args.depth !== null) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(pktLines([...lines, 'delim']));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH_PKT);
  const response = Buffer.concat(parts);
  cacheSet(cachesFor(repo).fetchV2, cacheKey, response);
  return response;
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  // Key on the raw body (same bytes = same args) so a cache hit skips the parse.
  const cacheKey = `${repo.version}|${body.toString('latin1')}`;
  const cached = cachesFor(repo).fetchV0.get(cacheKey);
  if (cached !== undefined) return cached;
  const args = parseV0FetchArgs(body);
  const { pack, shallow, unshallow } = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH_PKT);
  const response = Buffer.concat(parts);
  cacheSet(cachesFor(repo).fetchV0, cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Validate the first pkt-line of a receive-pack body: `<40-hex> <40-hex>
 * refs/...`, ignoring a trailing newline and anything after a NUL (the
 * capability list). The same shape the suite's client always sends, checked
 * without a regex.
 */
export function firstPushLineOk(body: Buffer): boolean {
  const len = pktLenAt(body, 0);
  if (len < 4 || 4 + len - 4 > body.length) return false;
  const line = body.subarray(4, len).toString('utf8');
  const nul = line.indexOf('\u0000');
  const head = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
  if (head.length < 87) return false;
  if (head[40] !== ' ' || head[81] !== ' ') return false;
  if (!head.startsWith('refs/', 82)) return false;
  return isOid(head.slice(0, 40)) && isOid(head.slice(41, 81));
}

/**
 * Parse a receive-pack body into its ref commands and the pack bytes, reading
 * the pkt-lines straight out of the buffer: no generic decode, no regex, and
 * the pack bytes are never copied (the rest is a subarray view). Lines that do
 * not parse as `<old> <new> <ref>` are skipped, as the generic path did.
 */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = pktLenAt(body, offset);
    if (length === -1) break;
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    const line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    const nul = text.indexOf('\u0000');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const sp1 = head.indexOf(' ');
    const sp2 = sp1 === -1 ? -1 : head.indexOf(' ', sp1 + 1);
    if (sp1 === -1 || sp2 === -1 || head.indexOf(' ', sp2 + 1) !== -1) continue;
    const oldOid = head.slice(0, sp1);
    const newOid = head.slice(sp1 + 1, sp2);
    const ref = head.slice(sp2 + 1);
    if (!isOid(oldOid) || !isOid(newOid)) continue;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: body.subarray(offset) };
}

interface PushReportLine {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

/** Receive-pack: parse the ref commands, unpack the pack, apply the ref updates. */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { commands, pack } = parsePushBody(body);
  const reportLines: PushReportLine[] = [];
  let unpackOk = true;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && pack.length > 0) {
    try {
      const objects = readPack(pack);
      forge.putPackObjects(repo, objects);
    } catch {
      unpackOk = false;
      for (const command of commands) {
        reportLines.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      }
      return { status: 200, body: pushReportBody(unpackOk, reportLines) };
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        reportLines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        forge.deleteRef(repo, command.ref);
        reportLines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      reportLines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== null) {
        reportLines.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        forge.setRef(repo, command.ref, command.newOid);
        reportLines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === null || command.oldOid !== current) {
      reportLines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(command.oldOid, command.newOid, lookup)) {
      reportLines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    forge.setRef(repo, command.ref, command.newOid);
    reportLines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { status: 200, body: pushReportBody(unpackOk, reportLines) };
}

/** The report-status stream inside sideband band 1, built into one buffer. */
function pushReportBody(unpackOk: boolean, lines: readonly PushReportLine[]): Buffer {
  const texts: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const entry of lines) {
    texts.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  // Inner pkt-lines: 4 header bytes + text each; the band-1 wrap adds 4 + 1;
  // then a flush.
  let innerLen = 0;
  for (const text of texts) innerLen += 4 + Buffer.byteLength(text, 'utf8');
  const total = 4 + 1 + innerLen + 4;
  const out = Buffer.allocUnsafe(total);
  let pos = 0;
  out.write((innerLen + 5).toString(16).padStart(4, '0'), pos, 4, 'ascii');
  pos += 4;
  out[pos] = 1;
  pos += 1;
  for (const text of texts) {
    const len = Buffer.byteLength(text, 'utf8') + 4;
    out.write(len.toString(16).padStart(4, '0'), pos, 4, 'ascii');
    pos += 4;
    pos += out.write(text, pos, 'utf8');
  }
  out.write('0000', pos, 4, 'ascii');
  return out;
}

export { parseTree };
