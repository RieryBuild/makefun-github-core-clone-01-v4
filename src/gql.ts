// The GraphQL v4 surface (/api/graphql): a hand-written lexer, recursive-descent
// parser and executor for the documents the suite sends, over the same forge
// store as REST. No dependency on any GraphQL library — the surface is small
// (a few dozen fields) and the suite's contract is pinned by checks-graphql.ts:
//
//   - POST {query, variables} or a JSON array (batching -> responses in order).
//   - A GraphQL-level failure (an unknown field) is HTTP 200 with an errors
//     array; the message names the field, e.g.
//     `Cannot query field "noSuchFieldOnViewer" on type "User".`
//   - data.repository is null with NO errors for an unknown repository.
//   - Global ids are opaque and stable: base64 of `Repository:owner/name`,
//     `Issue:owner/name:number`, `PullRequest:owner/name:number`.
//   - Issue state OPEN/CLOSED, pull-request state OPEN/CLOSED/MERGED, mergeable
//     MERGEABLE/CONFLICTING/UNKNOWN (the same conflict rule as the REST merge).
//   - Issues pagination: first + after (an opaque base64 `cursor:N`), pageInfo
//     {hasNextPage, endCursor}; CREATED_AT ordering is the per-repo creation
//     sequence.
//   - Mutations are the same operations as REST (create/close issue, create/
//     merge pull request, add comment) and their effects are visible through
//     REST afterwards. Directives (@skip/@include) are parsed and ignored.
//
// Layout note: the schema is one merged table per type (fields in introspection
// order plus each field's return type), from which the field sets and return
// lookups are derived. Resolvers are one switch function per type, not a
// nested record — the executor dispatches on the runtime object's __typename.

import {
  TRIAL_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  decodeGlobalId,
  globalId,
  parseCommit,
  type Comment,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { invalidateIssue } from './restapi.ts';

void VIEWER_ID;

// ---------------------------------------------------------------------------------------------
// schema: one merged definition per type
// ---------------------------------------------------------------------------------------------

interface TypeDef {
  /** Field names in introspection order. */
  readonly fields: readonly string[];
  /** The named return type of each field that has sub-selections. */
  readonly returns: Readonly<Record<string, string>>;
}

const TYPE_DEFS: Readonly<Record<string, TypeDef>> = {
  Query: {
    fields: ['viewer', 'repository', 'node', '__type', '__schema'],
    returns: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  },
  Mutation: {
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    returns: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'url'],
    returns: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', description: 'String', isPrivate: 'Boolean', createdAt: 'String', url: 'String' },
  },
  Issue: {
    fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'repository', 'comments', 'labels'],
    returns: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'IssueState', createdAt: 'String', updatedAt: 'String', url: 'String', author: 'User', repository: 'Repository', comments: 'IssueCommentConnection', labels: 'Label' },
  },
  PullRequest: {
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'createdAt', 'url', 'author', 'repository'],
    returns: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection', headRef: 'Ref', baseRef: 'Ref', mergedAt: 'String', mergeCommit: 'Commit', createdAt: 'String', url: 'String', author: 'User', repository: 'Repository' },
  },
  User: {
    fields: ['login', 'id', 'name', 'email'],
    returns: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  },
  IssueConnection: {
    fields: ['nodes', 'pageInfo', 'totalCount'],
    returns: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestConnection: {
    fields: ['nodes', 'pageInfo', 'totalCount'],
    returns: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  IssueCommentConnection: {
    fields: ['nodes', 'pageInfo', 'totalCount'],
    returns: { nodes: 'IssueComment', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestChangedFileConnection: {
    fields: ['nodes', 'pageInfo', 'totalCount'],
    returns: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PageInfo: {
    fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
    returns: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  },
  Ref: {
    fields: ['name', 'target'],
    returns: { name: 'String', target: 'Commit' },
  },
  Commit: {
    fields: ['oid', 'message'],
    returns: { oid: 'String', message: 'String' },
  },
  IssueComment: {
    fields: ['id', 'body', 'author', 'createdAt'],
    returns: { id: 'ID', body: 'String', author: 'User', createdAt: 'String' },
  },
  PullRequestChangedFile: {
    fields: ['path'],
    returns: { path: 'String' },
  },
  Label: {
    fields: ['name', 'color'],
    returns: { name: 'String', color: 'String' },
  },
  CreateIssuePayload: { fields: ['issue'], returns: { issue: 'Issue' } },
  CloseIssuePayload: { fields: ['issue'], returns: { issue: 'Issue' } },
  CreatePullRequestPayload: { fields: ['pullRequest'], returns: { pullRequest: 'PullRequest' } },
  MergePullRequestPayload: { fields: ['pullRequest'], returns: { pullRequest: 'PullRequest' } },
  AddCommentPayload: { fields: ['commentEdge'], returns: { commentEdge: 'CommentEdge' } },
  CommentEdge: { fields: ['node'], returns: { node: 'IssueComment' } },
  __Type: {
    fields: ['name', 'kind', 'fields', 'enumValues'],
    returns: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  },
  __Field: { fields: ['name'], returns: { name: 'String' } },
  __EnumValue: { fields: ['name'], returns: { name: 'String' } },
  __Schema: {
    fields: ['types', 'queryType', 'mutationType'],
    returns: { types: '__Type', queryType: '__Type', mutationType: '__Type' },
  },
  // The Node interface: a node is always addressed by its id, and a query may
  // read that id directly (the node(id:) document does) before narrowing with
  // an inline fragment.
  Node: { fields: ['id'], returns: { id: 'ID' } },
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

/** Per-type field sets for O(1) validation lookups. */
const FIELD_SETS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(TYPE_DEFS).map(([name, def]) => [name, new Set(def.fields)]),
);

// ---------------------------------------------------------------------------------------------
// lexer (streaming: one token of lookahead, no full token array)
// ---------------------------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Tok {
  readonly kind: TokKind;
  readonly value: string;
}

const EOF_TOK: Tok = { kind: 'eof', value: '' };
const PUNCTS = '!$():=@[]{}|&';
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

class Lexer {
  private pos = 0;
  private buffered: Tok | null = null;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  peek(): Tok {
    if (this.buffered === null) this.buffered = this.scan();
    return this.buffered;
  }

  next(): Tok {
    const tok = this.peek();
    this.buffered = null;
    return tok;
  }

  private scan(): Tok {
    const src = this.source;
    let i = this.pos;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
        i += 1;
        continue;
      }
      if (ch === '#') {
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      break;
    }
    if (i >= src.length) {
      this.pos = i;
      return EOF_TOK;
    }
    const ch = src[i]!;
    if (ch === '.' && src.startsWith('...', i)) {
      this.pos = i + 3;
      return { kind: 'punct', value: '...' };
    }
    if (PUNCTS.includes(ch)) {
      this.pos = i + 1;
      return { kind: 'punct', value: ch };
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]!;
          if (esc === 'u' && i + 5 < src.length) {
            value += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += ESCAPES[esc] ?? esc;
            i += 2;
          }
        } else {
          value += src[i];
          i += 1;
        }
      }
      this.pos = i + 1;
      return { kind: 'string', value };
    }
    if (isDigit(ch) || ch === '-') {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && isDigit(src[j]!)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && isDigit(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && isDigit(src[j]!)) j += 1;
      }
      this.pos = j;
      return { kind: isFloat ? 'float' : 'int', value: src.slice(i, j) };
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < src.length && isNameChar(src[j]!)) j += 1;
      this.pos = j;
      return { kind: 'name', value: src.slice(i, j) };
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
}

// ---------------------------------------------------------------------------------------------
// parser (recursive descent over the lexer)
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum'; readonly value: unknown }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

type Selection =
  | { readonly t: 'field'; readonly name: string; readonly alias?: string; readonly args?: Array<{ name: string; value: ValueNode }>; readonly selections?: Selection[] }
  | { readonly t: 'spread'; readonly fragmentName: string }
  | { readonly t: 'inline'; readonly typeCondition?: string; readonly selections: Selection[] };

interface Operation {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name?: string;
  readonly variables: Array<{ name: string; defaultValue?: ValueNode }>;
  readonly selections: Selection[];
}

interface FragmentDef {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: Selection[];
}

interface GqlDocument {
  readonly operations: Operation[];
  readonly fragments: Map<string, FragmentDef>;
}

class GqlParser {
  private readonly lexer: Lexer;

  constructor(lexer: Lexer) {
    this.lexer = lexer;
  }

  private peek(): Tok {
    return this.lexer.peek();
  }

  private next(): Tok {
    return this.lexer.next();
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Expected ${value}, got ${tok.value}`);
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`Expected a name, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): GqlDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', variables: [], selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token ${tok.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    this.expectPunct('(');
    const defs: Array<{ name: string; defaultValue?: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { t: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const fragmentName = this.next().value;
        this.parseDirectives();
        return { t: 'spread', fragmentName };
      }
      this.parseDirectives();
      return { t: 'inline', selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : undefined;
    this.parseDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { t: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  /** Directives are parsed and discarded: the suite never relies on @skip/@include. */
  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseValue(): ValueNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') {
      this.next();
      return { kind: 'string', value: tok.value };
    }
    if (tok.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    }
    if (tok.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(tok.value) };
    }
    if (tok.kind === 'name') {
      this.next();
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected value token ${tok.value}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.values.map((child) => evalValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
    default:
      return node.value ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// validation: an unknown field fails the whole operation with a named error
// ---------------------------------------------------------------------------------------------

function validateSelections(
  typeName: string,
  selections: readonly Selection[],
  fragments: Map<string, FragmentDef>,
  errors: Array<{ message: string }>,
  visited: Set<string>,
): void {
  for (const selection of selections) {
    if (selection.t === 'field') {
      const name = selection.name;
      if (name === '__typename') continue;
      if (name === '__type' || name === '__schema') {
        if (typeName !== 'Query') {
          errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
          continue;
        }
        if (selection.selections) {
          validateSelections(name === '__type' ? '__Type' : '__Schema', selection.selections, fragments, errors, visited);
        }
        continue;
      }
      if (!(FIELD_SETS[typeName]?.has(name) ?? false)) {
        errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
        continue;
      }
      if (selection.selections) {
        const returnType = TYPE_DEFS[typeName]?.returns[name];
        if (returnType !== undefined) validateSelections(returnType, selection.selections, fragments, errors, visited);
      }
    } else if (selection.t === 'inline') {
      validateSelections(selection.typeCondition ?? typeName, selection.selections, fragments, errors, visited);
    } else {
      const fragment = fragments.get(selection.fragmentName);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.fragmentName}".` });
        continue;
      }
      if (visited.has(fragment.name)) continue;
      visited.add(fragment.name);
      validateSelections(fragment.typeCondition, fragment.selections, fragments, errors, visited);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// runtime values
// ---------------------------------------------------------------------------------------------

type RuntimeObject = { __typename: string; [key: string]: unknown };
type RuntimeValue = RuntimeObject | string | number | boolean | null | RuntimeValue[];

function isRuntimeObject(value: unknown): value is RuntimeObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as RuntimeObject).__typename === 'string';
}

function repoOf(obj: RuntimeObject): Repo {
  return obj.repo as Repo;
}

function issueOf(obj: RuntimeObject): Issue {
  return obj.issue as Issue;
}

function pullOf(obj: RuntimeObject): Pull {
  return obj.pull as Pull;
}

const repoNode = (repo: Repo): RuntimeObject => ({ __typename: 'Repository', repo });
const issueNode = (repo: Repo, issue: Issue): RuntimeObject => ({ __typename: 'Issue', repo, issue });
const pullNode = (repo: Repo, pull: Pull): RuntimeObject => ({ __typename: 'PullRequest', repo, pull });
const userNode = (login: string): RuntimeObject => ({ __typename: 'User', login });

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

/** The first index after a `cursor:N` (0 for a missing or malformed cursor). */
function indexAfterCursor(cursor: unknown, total: number): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return 0;
  }
  if (!text.startsWith('cursor:')) return 0;
  const digits = text.slice(7);
  if (digits.length === 0) return 0;
  for (let i = 0; i < digits.length; i += 1) {
    const code = digits.charCodeAt(i);
    if (code < 48 || code > 57) return 0;
  }
  return Math.min(Number.parseInt(digits, 10) + 1, total);
}

function pageInfoFor(nodes: readonly unknown[], total: number, first: number | null, start: number): RuntimeObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: first !== null && start + nodes.length < total,
    endCursor: nodes.length === 0 ? null : cursorFor(start + nodes.length - 1),
    hasPreviousPage: start > 0,
    startCursor: nodes.length === 0 ? null : cursorFor(start),
  };
}

function connection(typeName: string, all: RuntimeValue[], first: number | null, after: unknown): RuntimeObject {
  const start = indexAfterCursor(after, all.length);
  const nodes = first === null ? all.slice(start) : all.slice(start, start + first);
  return { __typename: typeName, nodes, pageInfo: pageInfoFor(nodes, all.length, first, start), totalCount: all.length };
}

function firstArg(args: Record<string, unknown>): number | null {
  return typeof args.first === 'number' ? args.first : null;
}

/** Split an `owner/name` global-id part into its repo (null when malformed/unknown). */
function repoFromIdPart(forge: Forge, part: string | undefined): Repo | null {
  if (part === undefined) return null;
  const slash = part.indexOf('/');
  if (slash < 0) return null;
  const owner = part.slice(0, slash);
  const name = part.slice(slash + 1);
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(name) ?? null;
}

function commentNode(repo: Repo, issue: Issue, comment: Comment): RuntimeObject {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', `${repo.owner}/${repo.name}`, issue.number, comment.id),
    body: comment.body,
    repo,
    issue,
    comment,
  };
}

// ---------------------------------------------------------------------------------------------
// resolvers: one switch per type. A resolver throws on a mutation failure; the
// executor turns the thrown message into a field error and nulls the field.
// ---------------------------------------------------------------------------------------------

type ResolverFn = (obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge) => unknown;

function resolveQuery(_obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge): unknown {
  switch (field) {
    case 'viewer':
      return userNode(VIEWER_LOGIN);
    case 'repository': {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = forge.getRepo(name);
      return repo === undefined ? null : repoNode(repo);
    }
    case 'node': {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoFromIdPart(forge, decoded.parts[0]);
        return repo === null ? null : repoNode(repo);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = repoFromIdPart(forge, decoded.parts[0]);
        const number = Number.parseInt(decoded.parts[1] ?? '', 10);
        if (repo === null || !Number.isFinite(number)) return null;
        if (decoded.kind === 'Issue') {
          const issue = forge.getIssue(repo, number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        const pull = forge.getPull(repo, number);
        return pull === undefined ? null : pullNode(repo, pull);
      }
      return null;
    }
    case '__type': {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const enumValues = ENUM_VALUES[name];
      if (enumValues !== undefined) {
        return {
          __typename: '__Type',
          name,
          kind: 'ENUM',
          fields: null,
          enumValues: enumValues.map((value) => ({ __typename: '__EnumValue', name: value })),
        };
      }
      const def = TYPE_DEFS[name];
      if (def !== undefined) {
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: def.fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
          enumValues: null,
        };
      }
      return null;
    }
    case '__schema':
      return { __typename: '__Schema', types: [], queryType: null, mutationType: null };
    default:
      return undefined;
  }
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  return (args.input ?? {}) as Record<string, unknown>;
}

function resolveMutation(_obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge): unknown {
  switch (field) {
    case 'createIssue': {
      const input = inputOf(args);
      const repositoryId = input.repositoryId;
      const title = input.title;
      if (typeof repositoryId !== 'string' || typeof title !== 'string') {
        throw new Error('createIssue requires repositoryId and title');
      }
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('Unknown repository');
      const repo = repoFromIdPart(forge, decoded.parts[0]);
      if (repo === null) throw new Error('Unknown repository');
      const created = forge.createIssue(repo, title, (input.body as string | undefined) ?? '', []);
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, created) };
    }
    case 'closeIssue': {
      const input = inputOf(args);
      const issueId = input.issueId;
      if (typeof issueId !== 'string') throw new Error('closeIssue requires issueId');
      const decoded = decodeGlobalId(issueId);
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('Unknown issue');
      const repo = repoFromIdPart(forge, decoded.parts[0]);
      const number = Number.parseInt(decoded.parts[1] ?? '', 10);
      const issue = repo === null ? undefined : forge.getIssue(repo, number);
      if (issue === undefined) throw new Error('Unknown issue');
      issue.state = 'closed';
      // The REST pool for this issue must go too, or GET would serve stale JSON.
      invalidateIssue(issue);
      return { __typename: 'CloseIssuePayload', issue: issueNode(repo!, issue) };
    }
    case 'createPullRequest': {
      const input = inputOf(args);
      const repositoryId = input.repositoryId;
      const title = input.title;
      const baseRefName = input.baseRefName;
      const headRefName = input.headRefName;
      if (typeof repositoryId !== 'string' || typeof title !== 'string' || typeof baseRefName !== 'string' || typeof headRefName !== 'string') {
        throw new Error('createPullRequest requires repositoryId, title, baseRefName and headRefName');
      }
      const decoded = decodeGlobalId(repositoryId);
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('Unknown repository');
      const repo = repoFromIdPart(forge, decoded.parts[0]);
      if (repo === null) throw new Error('Unknown repository');
      const created = forge.createPull(repo, title, (input.body as string | undefined) ?? '', headRefName, baseRefName);
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, created) };
    }
    case 'mergePullRequest': {
      const input = inputOf(args);
      const pullRequestId = input.pullRequestId;
      if (typeof pullRequestId !== 'string') throw new Error('mergePullRequest requires pullRequestId');
      const decoded = decodeGlobalId(pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('Unknown pull request');
      const repo = repoFromIdPart(forge, decoded.parts[0]);
      const number = Number.parseInt(decoded.parts[1] ?? '', 10);
      const pull = repo === null ? undefined : forge.getPull(repo, number);
      if (pull === undefined) throw new Error('Unknown pull request');
      const sha = forge.mergePull(repo!, pull);
      if (sha === null) throw new Error('Merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repo!, pull) };
    }
    case 'addComment': {
      const input = inputOf(args);
      const subjectId = input.subjectId;
      const body = input.body;
      if (typeof subjectId !== 'string' || typeof body !== 'string') throw new Error('addComment requires subjectId and body');
      const decoded = decodeGlobalId(subjectId);
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('Unknown subject');
      const repo = repoFromIdPart(forge, decoded.parts[0]);
      const number = Number.parseInt(decoded.parts[1] ?? '', 10);
      const issue = repo === null ? undefined : forge.getIssue(repo, number);
      if (issue === undefined) throw new Error('Unknown issue');
      const comment = forge.createComment(repo!, issue, body);
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: commentNode(repo!, issue, comment) } };
    }
    default:
      return undefined;
  }
}

function resolveRepository(obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge): unknown {
  const repo = repoOf(obj);
  switch (field) {
    case 'id':
      return globalId('Repository', `${repo.owner}/${repo.name}`);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return userNode(VIEWER_LOGIN);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip, repo } };
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = forge.getIssue(repo, number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    case 'issues': {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const ascending = orderBy.direction === 'ASC';
      let list = [...repo.issues];
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => (ascending ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return connection('IssueConnection', list.map((issue) => issueNode(repo, issue)), firstArg(args), args.after);
    }
    case 'pullRequests': {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let list = [...repo.pulls];
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((pull) => wanted.has(pull.merged ? 'merged' : pull.state));
      }
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return connection('PullRequestConnection', list.map((pull) => pullNode(repo, pull)), firstArg(args), args.after);
    }
    case 'pullRequest': {
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pull = forge.getPull(repo, number);
      return pull === undefined ? null : pullNode(repo, pull);
    }
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'createdAt':
      return TRIAL_ISO;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}`;
    default:
      return undefined;
  }
}

function resolveIssue(obj: RuntimeObject, field: string, args: Record<string, unknown>, _forge: Forge): unknown {
  const repo = repoOf(obj);
  const issue = issueOf(obj);
  switch (field) {
    case 'id':
      return globalId('Issue', `${repo.owner}/${repo.name}`, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'createdAt':
      return TRIAL_ISO;
    case 'updatedAt':
      return TRIAL_ISO;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'author':
      return userNode(VIEWER_LOGIN);
    case 'repository':
      return repoNode(repo);
    case 'comments': {
      const nodes = issue.comments.map((comment) => commentNode(repo, issue, comment));
      return connection('IssueCommentConnection', nodes, firstArg(args), args.after);
    }
    case 'labels':
      return issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' }));
    default:
      return undefined;
  }
}

function resolvePullRequest(obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge): unknown {
  const repo = repoOf(obj);
  const pull = pullOf(obj);
  switch (field) {
    case 'id':
      return globalId('PullRequest', `${repo.owner}/${repo.name}`, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      if (pull.merged) return 'MERGED';
      return pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable': {
      if (pull.state !== 'open') return 'UNKNOWN';
      return forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    case 'files': {
      const changes = forge.pullFiles(repo, pull);
      const nodes = changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path }));
      return connection('PullRequestChangedFileConnection', nodes, firstArg(args), args.after);
    }
    case 'headRef':
      return { __typename: 'Ref', name: pull.headRef, target: { __typename: 'Commit', oid: pull.headSha, repo } };
    case 'baseRef':
      return { __typename: 'Ref', name: pull.baseRef, target: { __typename: 'Commit', oid: pull.baseSha, repo } };
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit':
      if (pull.mergeCommitSha === null) return null;
      return { __typename: 'Commit', oid: pull.mergeCommitSha, repo };
    case 'createdAt':
      return TRIAL_ISO;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'author':
      return userNode(VIEWER_LOGIN);
    case 'repository':
      return repoNode(repo);
    default:
      return undefined;
  }
}

function resolveUser(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  switch (field) {
    case 'login':
      return obj.login as string;
    case 'id':
      return globalId('User', obj.login as string);
    case 'name':
      return 'ada iversen';
    case 'email':
      return 'adaiversen@example.invalid';
    default:
      return undefined;
  }
}

/** The four connection types and the payload/edge types read straight off the object. */
function resolvePassthrough(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  const value = obj[field];
  return value === undefined ? undefined : value;
}

function resolvePageInfo(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  return resolvePassthrough(obj, field, _args, _forge);
}

function resolveRef(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  return resolvePassthrough(obj, field, _args, _forge);
}

function resolveCommit(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  switch (field) {
    case 'oid':
      return obj.oid as string;
    case 'message': {
      const repo = repoOf(obj);
      const object = repo.objects.get(obj.oid as string);
      if (object === undefined || object.type !== 'commit') return '';
      return parseCommit(object.data).message;
    }
    default:
      return undefined;
  }
}

function resolveIssueComment(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  switch (field) {
    case 'id':
      return obj.id as string;
    case 'body':
      return obj.body as string;
    case 'author':
      return userNode(VIEWER_LOGIN);
    case 'createdAt':
      return TRIAL_ISO;
    default:
      return undefined;
  }
}

function resolveChangedFile(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  return field === 'path' ? (obj.path as string) : undefined;
}

function resolveLabel(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  return resolvePassthrough(obj, field, _args, _forge);
}

function resolveIntrospection(obj: RuntimeObject, field: string, _args: Record<string, unknown>, _forge: Forge): unknown {
  switch (field) {
    case 'name':
      return obj.name as string;
    case 'kind':
      return obj.kind as string;
    case 'fields':
      return (obj.fields ?? null) as RuntimeValue[] | null;
    case 'enumValues':
      return (obj.enumValues ?? null) as RuntimeValue[] | null;
    case 'types':
      return [];
    case 'queryType':
      return null;
    case 'mutationType':
      return null;
    default:
      return undefined;
  }
}

/** Dispatch to the per-type resolver; undefined means "no such field". */
function resolveField(typeName: string, obj: RuntimeObject, field: string, args: Record<string, unknown>, forge: Forge): unknown {
  let fn: ResolverFn | undefined;
  switch (typeName) {
    case 'Query':
      fn = resolveQuery;
      break;
    case 'Mutation':
      fn = resolveMutation;
      break;
    case 'Repository':
      fn = resolveRepository;
      break;
    case 'Issue':
      fn = resolveIssue;
      break;
    case 'PullRequest':
      fn = resolvePullRequest;
      break;
    case 'User':
      fn = resolveUser;
      break;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'PullRequestChangedFileConnection':
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'CommentEdge':
      fn = resolvePassthrough;
      break;
    case 'PageInfo':
      fn = resolvePageInfo;
      break;
    case 'Ref':
      fn = resolveRef;
      break;
    case 'Commit':
      fn = resolveCommit;
      break;
    case 'IssueComment':
      fn = resolveIssueComment;
      break;
    case 'PullRequestChangedFile':
      fn = resolveChangedFile;
      break;
    case 'Label':
      fn = resolveLabel;
      break;
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case '__Schema':
      fn = resolveIntrospection;
      break;
    default:
      fn = undefined;
  }
  return fn === undefined ? undefined : fn(obj, field, args, forge);
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function executeSelections(
  forge: Forge,
  obj: RuntimeObject,
  typeName: string,
  selections: readonly Selection[],
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.t === 'spread') {
      const fragment = fragments.get(selection.fragmentName);
      if (fragment === undefined) continue;
      const nested = executeSelections(forge, obj, fragment.typeCondition, fragment.selections, variables, fragments, errors);
      Object.assign(out, nested);
      continue;
    }
    if (selection.t === 'inline') {
      const condition = selection.typeCondition;
      if (condition !== undefined && condition !== typeName && condition !== 'Node') continue;
      const nested = executeSelections(forge, obj, condition ?? typeName, selection.selections, variables, fragments, errors);
      Object.assign(out, nested);
      continue;
    }
    const name = selection.name;
    const responseKey = selection.alias ?? name;
    if (name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args ?? []) args[arg.name] = evalValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolveField(typeName, obj, name, args, forge);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : 'Field error' });
      out[responseKey] = null;
      continue;
    }
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(forge, value, selection.selections, variables, fragments, errors);
  }
  return out;
}

function completeValue(
  forge: Forge,
  value: unknown,
  selections: readonly Selection[] | undefined,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(forge, item, selections, variables, fragments, errors));
  }
  if (isRuntimeObject(value)) {
    if (selections === undefined || selections.length === 0) return null;
    return executeSelections(forge, value, value.__typename, selections, variables, fragments, errors);
  }
  return value;
}

interface GqlResponse {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeRequest(forge: Forge, request: unknown): GqlResponse {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { data: null, errors: [{ message: 'Request must be a JSON object with a query field.' }] };
  }
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'Must provide a query string.' }] };
  }
  let document: GqlDocument;
  try {
    document = new GqlParser(new Lexer(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation =
    typeof operationName === 'string'
      ? document.operations.find((op) => op.name === operationName)
      : document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Unknown operation.' }] };
  }
  const vars: Record<string, unknown> = {};
  for (const def of operation.variables) {
    const provided = (variables as Record<string, unknown> | null)?.[def.name];
    if (provided !== undefined) vars[def.name] = provided;
    else if (def.defaultValue !== undefined) vars[def.name] = evalValue(def.defaultValue, {});
    else vars[def.name] = null;
  }
  const errors: Array<{ message: string }> = [];
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, document.fragments, errors, new Set());
  if (errors.length > 0) return { data: null, errors };
  const root: RuntimeObject = { __typename: rootType };
  const data = executeSelections(forge, root, rootType, operation.selections, vars, document.fragments, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Handle one GraphQL request body (a single object or an array for batching). */
export function handleGraphql(forge: Forge, body: Buffer | null): { status: number; body: string } {
  if (body === null || body.length === 0) {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Must provide a query string.' }] }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }) };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((request) => executeRequest(forge, request));
    return { status: 200, body: JSON.stringify(responses) };
  }
  return { status: 200, body: JSON.stringify(executeRequest(forge, parsed)) };
}
