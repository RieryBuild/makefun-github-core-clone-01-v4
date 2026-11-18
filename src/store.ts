// The forge's in-memory store: git objects, refs, repositories, issues and pull
// requests, all held for the life of the process. Nothing here touches the disk
// during a request; a replay rebuilds the same state from the same requests.
//
// Identity is fixed by the trial's seeded scenario: the bearer token names one
// login ("adaiversen"), and every repository belongs to that login. Any other
// owner in a URL is a 404, never a 403, so repositories are keyed by name alone
// and the owner is checked once at routing time.
//
// Clocks are fixed too: server-made commits and timestamps use MAKEFUN_TRIAL_NOW
// (or a constant fallback), never the wall clock, so a live run and its replay
// produce byte-identical commits.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The login the trial's bearer token names. */
export const VIEWER_LOGIN = 'adaiversen';
/** The viewer's numeric user id (the scenario's first user). */
export const VIEWER_ID = 1000;
/** The identity server-made commits carry. */
export const FORGE_IDENTITY = 'adaiversen <adaiversen@example.invalid>';
/** The fixed epoch used when MAKEFUN_TRIAL_NOW is absent. */
export const FALLBACK_EPOCH_SEC = 1700000000;

function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_EPOCH_SEC;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : FALLBACK_EPOCH_SEC;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : FALLBACK_EPOCH_SEC;
}

/** The trial's fixed now, epoch seconds. */
export const TRIAL_EPOCH_SEC = trialNowSec();
/** The trial's fixed now as an ISO instant. */
export const TRIAL_ISO = new Date(TRIAL_EPOCH_SEC * 1000).toISOString();

export const ZERO_OID = '0'.repeat(40);

/** The four object types git stores. */
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

const TYPE_TO_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const lower = c >= 97 && c <= 102;
    if (!digit && !lower) return false;
  }
  return true;
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`);
  hash.update(data);
  return hash.digest('hex');
}

/** SHA-1 of one buffer, hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// object codecs
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as `name/`. */
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeEntryCompare);
  const parts: Buffer[] = new Array(sorted.length * 2);
  let i = 0;
  for (const entry of sorted) {
    parts[i++] = Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8');
    parts[i++] = Buffer.from(entry.oid, 'hex');
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let start = 0;
  while (start <= headerText.length) {
    const eol = headerText.indexOf('\n', start);
    const line = eol < 0 ? headerText.slice(start) : headerText.slice(start, eol);
    if (line !== '') {
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      if (key === 'tree') tree = value;
      else if (key === 'parent') parents.push(value);
      else if (key === 'author') author = value;
      else if (key === 'committer') committer = value;
    }
    if (eol < 0) break;
    start = eol + 1;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored verbatim. */
export function buildCommitBytes(tree: string, parents: readonly string[], message: string, timestamp: number = TRIAL_EPOCH_SEC): Buffer {
  const who = `${FORGE_IDENTITY} ${timestamp} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${who}\ncommitter ${who}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: ObjType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  let start = 0;
  while (start <= headerText.length) {
    const eol = headerText.indexOf('\n', start);
    const line = eol < 0 ? headerText.slice(start) : headerText.slice(start, eol);
    if (line !== '') {
      const space = line.indexOf(' ');
      if (space >= 0) {
        const key = line.slice(0, space);
        const value = line.slice(space + 1);
        if (key === 'object') object = value;
        else if (key === 'type' && (value === 'commit' || value === 'tree' || value === 'blob' || value === 'tag')) type = value;
        else if (key === 'tag') tag = value;
        else if (key === 'tagger') tagger = value;
      }
    }
    if (eol < 0) break;
    start = eol + 1;
  }
  return { object, type, tag, tagger, message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

// ---------------------------------------------------------------------------
// packfile codec (plain objects only: the suite's client never sends deltas)
// ---------------------------------------------------------------------------

export interface PackInput {
  readonly type: ObjType;
  readonly data: Buffer;
}

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas), deduplicated by id and sorted
 * by id for determinism. Ids are computed once per object.
 */
export function writePack(objects: Iterable<PackInput>): Buffer {
  const byOid = new Map<string, PackInput>();
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (!byOid.has(oid)) byOid.set(oid, object);
  }
  const list = [...byOid.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, object]) => object);
  const parts: Buffer[] = new Array(1 + list.length * 2);
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts[0] = header;
  let i = 1;
  for (const object of list) {
    parts[i++] = packObjectHeader(object.type, object.data.length);
    parts[i++] = deflateSync(object.data);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Read a packfile of plain objects. Returns the objects keyed by their recomputed
 * id; a delta entry or a corrupt stream is an error (the suite's client writes
 * plain packs only).
 */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack[0] !== 0x50 || pack[1] !== 0x41 || pack[2] !== 0x43 || pack[3] !== 0x4b) throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!computed.equals(pack.subarray(trailerStart))) throw new Error('pack trailer does not match its bytes');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    // Inline varint: first byte holds the type in bits 4-6 and the low 4 size bits.
    let byte = pack[offset]!;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('pack carries delta objects, which this forge does not unpack');
    const type = CODE_TO_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error(`pack entry ${index} declares ${size} bytes but inflated to ${inflated.buffer.length}`);
    offset += inflated.engine.bytesWritten;
    const oid = hashObject(type, inflated.buffer);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.buffer });
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return objects;
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type Lookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`, following commit -> tree + parents,
 * tag -> target, tree -> entries (gitlinks skipped). `maxGeneration` caps how
 * many commit generations from a root are followed; trees and blobs of an
 * allowed commit are always included. Returns the id set and, when a depth cap
 * is given, the shallow boundary commits (allowed commits at the cap that
 * still have parents).
 *
 * The work queue is two parallel arrays (oids + generations) instead of an
 * array of small objects: a full-clone walk queues thousands of entries.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: Lookup,
  options: { maxGeneration?: number; stopAt?: ReadonlySet<string> } = {},
): { objects: Set<string>; shallow: string[] } {
  const seen = new Set<string>();
  const shallow: string[] = [];
  const maxGen = options.maxGeneration;
  const stopAt = options.stopAt;
  const queueOids: string[] = [];
  const queueGens: number[] = [];
  for (const root of roots) {
    if (isOid(root)) {
      queueOids.push(root);
      queueGens.push(1);
    }
  }
  while (queueOids.length > 0) {
    const oid = queueOids.pop()!;
    const gen = queueGens.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (stopAt !== undefined && stopAt.has(oid)) {
        // A shallow boundary the caller already holds: its tree and blobs are
        // held, but its parents are not — do not follow them.
      } else if (maxGen !== undefined && gen >= maxGen) {
        if (commit.parents.length > 0) shallow.push(oid);
      } else {
        for (const parent of commit.parents) {
          queueOids.push(parent);
          queueGens.push(gen + 1);
        }
      }
      queueOids.push(commit.tree);
      queueGens.push(gen);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      queueOids.push(tag.object);
      queueGens.push(gen);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queueOids.push(entry.oid);
        queueGens.push(gen);
      }
    }
  }
  return { objects: seen, shallow };
}

/** The first common ancestor of two commits (the merge-base), or null. */
export function mergeBase(a: string, b: string, lookup: Lookup): string | null {
  const ancestors = new Map<string, number>();
  const stackA: string[] = [a];
  const distA: number[] = [0];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    const dist = distA.pop()!;
    if (ancestors.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    ancestors.set(oid, dist);
    for (const parent of parseCommit(object.data).parents) {
      stackA.push(parent);
      distA.push(dist + 1);
    }
  }
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const seenB = new Set<string>();
  const stackB: string[] = [b];
  const distB: number[] = [0];
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    const dist = distB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const aDist = ancestors.get(oid);
    if (aDist !== undefined && aDist + dist < bestDist) {
      bestDist = aDist + dist;
      best = oid;
    }
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      stackB.push(parent);
      distB.push(dist + 1);
    }
  }
  return best;
}

/** True when `ancestor` is an ancestor of `commit` (or the same commit). */
export function isAncestor(ancestor: string, commit: string, lookup: Lookup): boolean {
  if (ancestor === commit) return true;
  // Fast path (the push workload's shape: a linear child): the ancestor is the
  // commit's direct parent, so no visited set or queue is ever allocated.
  const head = lookup(commit);
  if (head === undefined || head.type !== 'commit') return false;
  const parents = parseCommit(head.data).parents;
  for (const parent of parents) if (parent === ancestor) return true;
  if (parents.length === 0) return false;
  const queue = [...parents];
  const seen = new Set<string>([commit]);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// the data model
// ---------------------------------------------------------------------------

/** A repository: metadata, git objects and refs, issues and pull requests. */
export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  /** Issues in creation order (lists) plus a number index (single GETs). */
  readonly issues: Issue[];
  readonly issuesByNumber: Map<number, Issue>;
  readonly pulls: Pull[];
  readonly pullsByNumber: Map<number, Pull>;
  /** One counter for issues and pull requests (GitHub shares the number space). */
  nextNumber: number;
  /** Monotonic generation: bumped on every mutation of refs or objects, so
      response caches (fetch packs) can key on it and never serve stale bytes. */
  version: number;
  /** Ref-only generation: bumped only when a ref is set or deleted. Ref
      advertisements depend on refs alone, so they key on this. */
  refVersion: number;
  /** The ref-name set's fingerprint: bumped only when a ref NAME is added or
      removed (not when a tip moves), so advertisement templates keyed on it
      survive every push. */
  refNamesVersion: number;
  /** Cached serializations, rebuilt on mutation. */
  repoJson: string | null;
  repoJsonBuf: Buffer | null;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  readonly comments: Comment[];
  cachedJson: string | null;
  cachedBuf: Buffer | null;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly createdSeq: number;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** A base64 Relay-style global id: opaque, stable, never the plain number. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

/** Flatten a tree into path -> {oid, mode}, following directories. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The diff between two trees: one entry per path that differs, in path order. */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string): FileChange[] {
  const base = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from !== undefined && to !== undefined) {
      if (from.oid === to.oid) continue;
      const { additions, deletions } = lineDiff(repo, from.oid, to.oid);
      changes.push({ path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: from.oid, newOid: to.oid });
    } else if (to !== undefined) {
      const { additions } = lineDiff(repo, null, to.oid);
      changes.push({ path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: to.oid });
    } else if (from !== undefined) {
      const { deletions } = lineDiff(repo, from.oid, null);
      changes.push({ path, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: from.oid, newOid: null });
    }
  }
  return changes;
}

/** Line counts for a blob change: added lines vs removed lines (an LCS over the middle). */
export function lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldText = oldOid === null ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
  const newText = newOid === null ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  if (oldMid.length === 0) return { additions: newMid.length, deletions: 0 };
  if (newMid.length === 0) return { additions: 0, deletions: oldMid.length };
  if (oldMid.length * newMid.length > 250_000) {
    // Large middle: count by multiset difference instead of an LCS.
    const oldCount = new Map<string, number>();
    for (const line of oldMid) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
    let shared = 0;
    for (const line of newMid) {
      const left = oldCount.get(line) ?? 0;
      if (left > 0) {
        oldCount.set(line, left - 1);
        shared += 1;
      }
    }
    return { additions: newMid.length - shared, deletions: oldMid.length - shared };
  }
  const dp: number[][] = Array.from({ length: oldMid.length + 1 }, () => new Array<number>(newMid.length + 1).fill(0));
  for (let i = oldMid.length - 1; i >= 0; i -= 1) {
    for (let j = newMid.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldMid[i] === newMid[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: newMid.length - lcs, deletions: oldMid.length - lcs };
}

// ---------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class Forge {
  /** Repositories by name. Every repository belongs to the viewer; the owner
      segment of a URL is checked at routing time, so no `owner/name` key is
      ever built on the hot path. */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextEntityId = 1;
  private nextCreatedSeq = 1;

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  /** Create a repository under the viewer; null when the name is taken or invalid. */
  createRepo(name: string, options: { private?: boolean; description?: string; defaultBranch?: string }): Repo | null {
    if (!REPO_NAME_RE.test(name)) return null;
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdSeq: this.nextCreatedSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
      nextNumber: 1,
      version: 1,
      refVersion: 1,
      refNamesVersion: 1,
      repoJson: null,
      repoJsonBuf: null,
    };
    this.nextRepoId += 1;
    this.nextCreatedSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** The viewer's repositories in creation order. */
  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Store an object, returning its id. Bumps the repo version when it adds one. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  /** Store a pack's objects (the receive-pack path). Bumps the version once. */
  putPackObjects(repo: Repo, objects: ReadonlyMap<string, GitObject>): number {
    let added = 0;
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        added += 1;
      }
    }
    if (added > 0) repo.version += 1;
    return added;
  }

  /** Set a ref, bumping the generations when it actually changes. A new ref NAME
      also bumps refNamesVersion (advertisement templates key on it). */
  setRef(repo: Repo, ref: string, oid: string): void {
    const prev = repo.refs.get(ref);
    if (prev === oid) return;
    if (prev === undefined) repo.refNamesVersion += 1;
    repo.refs.set(ref, oid);
    repo.version += 1;
    repo.refVersion += 1;
  }

  /** Delete a ref (bumping the generations). Returns true when it existed. */
  deleteRef(repo: Repo, ref: string): boolean {
    const existed = repo.refs.delete(ref);
    if (existed) {
      repo.version += 1;
      repo.refVersion += 1;
      repo.refNamesVersion += 1;
    }
    return existed;
  }

  /** Create a commit object on a repo and return its id. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    return this.putObject(repo, 'commit', buildCommitBytes(tree, parents, message));
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip of a branch (refs/heads/<branch>), or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branches as {name, sha}, default branch first, then name order. */
  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => {
      if (a.name === repo.defaultBranch) return -1;
      if (b.name === repo.defaultBranch) return 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  /** Commits reachable from a ref tip, newest first (depth-first, parents in order). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  /** Set a path's content in a tree, creating intermediate directories; returns the new root tree id. */
  setPath(repo: Repo, rootTree: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        const childObject = repo.objects.get(next);
        if (childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0) {
          entries.delete(name);
        } else {
          entries.set(name, { mode: '40000', name, oid: next });
        }
      }
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return build(rootTree, 0);
  }

  /** Read a path from a tree: the blob oid and mode, or a directory's entries, or null. */
  readPath(repo: Repo, rootTree: string, path: string): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = rootTree;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dir = repo.objects.get(entry.oid);
          return dir !== undefined && dir.type === 'tree' ? { kind: 'dir', entries: parseTree(dir.data) } : null;
        }
        return { kind: 'file', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const root = repo.objects.get(rootTree);
    return root !== undefined && root.type === 'tree' ? { kind: 'dir', entries: parseTree(root.data) } : null;
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): { name: string; color: string } {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
    }
    const issue: Issue = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextCreatedSeq,
      comments: [],
      cachedJson: null,
      cachedBuf: null,
    };
    this.nextEntityId += 1;
    this.nextCreatedSeq += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    repo.issuesByNumber.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issuesByNumber.get(number);
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    void repo;
    const comment: Comment = { id: this.nextEntityId, body, createdSeq: this.nextCreatedSeq };
    this.nextEntityId += 1;
    this.nextCreatedSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null) return { error: `Head branch '${head}' does not exist` };
    if (baseSha === null) return { error: `Base branch '${base}' does not exist` };
    const open = repo.pulls.find((pull) => pull.headRef === head && pull.state === 'open');
    if (open !== undefined) return { error: 'A pull request already exists for this head branch' };
    const pull: Pull = {
      id: this.nextEntityId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdSeq: this.nextCreatedSeq,
    };
    this.nextEntityId += 1;
    this.nextCreatedSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    repo.pullsByNumber.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pullsByNumber.get(number);
  }

  /** The file changes of a pull request (merge-base tree vs head tip tree). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(pull.headSha, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    return diffTrees(repo, baseTree, headTree);
  }

  /** Whether a squash merge of this pull request would conflict. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    // The base branch may have moved since the pull request was created (another
    // pull request merged onto it): the conflict is against the base branch's
    // current tip, not the tip the pull request recorded at creation.
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return false;
    const base = mergeBase(pull.headSha, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return false;
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headChanges = new Map(diffTrees(repo, baseTree, headTree).map((change) => [change.path, change]));
    const baseChanges = new Map(diffTrees(repo, baseTree, baseTipTree).map((change) => [change.path, change]));
    for (const [path, headChange] of headChanges) {
      const baseChange = baseChanges.get(path);
      if (baseChange === undefined) continue;
      if (headChange.newOid !== baseChange.newOid) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch: one merge commit whose tree
   * is the base tip tree with the head's changes applied. Returns the merge commit
   * id, or null when it conflicts or the pull request is already closed.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open' || pull.merged) return null;
    if (this.pullConflicts(repo, pull)) return null;
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === null) return null;
    const base = mergeBase(pull.headSha, baseTip, (oid) => repo.objects.get(oid));
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const changes = diffTrees(repo, baseTree, headTree);
    let tree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    for (const change of changes) {
      tree = this.setPath(repo, tree, change.path, change.newOid);
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeSha = this.makeCommit(repo, tree, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = TRIAL_ISO;
    pull.mergeCommitSha = mergeSha;
    pull.baseSha = mergeSha;
    repo.repoJson = null;
    repo.repoJsonBuf = null;
    return mergeSha;
  }
}
