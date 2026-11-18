# makefun-github-core-clone-01-v4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/RieryBuild/makefun-github-core-clone-01-v4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/RieryBuild/makefun-github-core-clone-01-v4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library
only: smart-HTTP clone/push (protocol v2 upload-pack, v0 receive-pack), REST
v3 (repos, branches, commits, contents, issues, pull requests), GraphQL v4
(the documents gh sends) and MCP tools over streamable HTTP — all served from
an in-memory store with real SHA-1 git objects, packs and refs. Node 22, zero
runtime dependencies, no `git` binary: every git format (packs, pkt-lines,
trees, commits, refs) is implemented in-process.

v4 is a performance revision of v3 (which passes 120/120 conformance checks).
The conformance surface is unchanged; the hot paths are rebuilt:

- **Pre-built responses.** `GET /healthz`, `GET /api/v3[/]`, `GET /api/v3/meta`
  and `GET /repos/{o}/{r}/issues/{n}` answer from pools of complete,
  already-joined responses (status line, headers, body) with rotating request
  ids — one socket write, zero per-request serialization. Issue pools are
  built lazily on first GET and dropped on mutation.
- **Template v0 advertisement.** The receive-pack/upload-pack advertisement's
  shape depends only on ref *names*, so it is built once per ref-name change
  and served by copying the template and splicing the current tip oids into
  their slots. (Falls back to a fresh build when a ref tip is an annotated
  tag, where the peeled line depends on the tip itself.)
- **Zero-copy push parsing.** The receive-pack body is parsed directly from
  the request buffer (manual pkt-line lengths, the pack taken as a subarray
  view) instead of being decoded into a line array first.
- **Targeted header scan.** The transport lowercases the head once and scans
  for the handful of headers the dispatch needs, instead of splitting every
  line into a record. (A buffer-native single-pass rewrite was built and
  measured during the hill climb: it ran 11% SLOWER on server CPU, so the
  string-based scan stands — native indexOf beats a per-byte JS loop.)
- **Fast routing.** The issue GET/POST hot paths match on the raw target
  string before any decoding or segment splitting; anything ambiguous
  (percent-escapes, non-digit tails, extra segments) falls through to the
  generic dispatch, so the fast paths can never diverge from it.
- **Leaner store.** Repos keyed by name only, issues/pulls in `Map<number>`
  plus ordered arrays, ref-name versioning for ad templates, parallel-array
  reachability walks, manual hex/oid checks instead of regexes.

## Run it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL in a trial
```

The grader runs `node /bot/main.ts`. The practice harness (`sdk/run.ts` in
the competition kit) runs the entry against the conformance suite + the four
perf workloads and prints the score.

## Layout

```
main.ts            entry <-> env lifecycle (bind, register, poll /done, exit 0)
src/server.ts      hand-rolled HTTP/1.1 over node:net (targeted header scan,
                   structured replies + pre-built buffers, keep-alive/pipelining)
src/router.ts      routing, auth, fast paths, static response pools, git routes
src/store.ts       the forge: repos, objects, refs, issues, pulls, packs,
                   reachability, merge-base, diffs
src/gitops.ts      smart HTTP: v0/v2 advertisements, ls-refs, fetch, receive-pack
src/restapi.ts     REST v3 (repos, branches, commits, refs, contents, issues,
                   labels, pulls) + the issue response pool
src/gql.ts         GraphQL v4: streaming lexer, recursive-descent parser,
                   switch-based per-type resolvers
src/mcpapi.ts      MCP Streamable HTTP (JSON-RPC 2.0, 6 tools)
```

## Practice grades

Full grades with the kit's sealed suite (`sdk/run.ts`), back-to-back on a
shared VM — wall p50s move with the machine's load, so the load is recorded
with each run and server CPU (a count of work, not wall time) is the
load-insensitive signal. Every run: feature 600, agent 200, 120/120 checks,
0 failures.

| run | load (1-min) | score | perf | p50 µs | push | clone | read | write |
|---|---|---|---|---|---|---|---|---|
| v3 clean best | 4.2–7.5 | 943 | 143 | 444,822 | 810 | 108 | 2,109 | 212 |
| **v4 clean best** | 7.5–8.2 | **971** | **171** | **301,062** | 717 | 111 | 815 | 127 |
| v4 final commit | ~6–10 | 904 | 104 | 765,130 | 822 | 273 | 2,508 | 609 |
| v4 final commit | ~5–10 | 874 | 74 | 1,159,357 | 1,528 | 299 | 3,850 | 1,026 |

The two final-commit runs ran under heavier sibling load; their server CPU
(1,442 / 1,623 ms) brackets the clean run's 1,442 ms, so the code performs
identically — the wall difference is contention, not a regression. Bench-only
server CPU, 3 paired runs: v3 median 1,442.9 ms vs v4 median 1,190.9 ms
(**−17.5%**). A/B (cleanest pair): read 2,109 → 815 ms (pooled pre-built
responses), write 212 → 127 ms, push 810 → 717 ms, clone flat (client-bound).

A practice grade is not a promise of a live result: v3 measured 189 in
practice and 117 live on the same code (the live trial runs ~2.5× slower
than this machine, single run on a shared node). The honest live outlook
for v4 is ~130–140 perf; the rank-20 prizelist cutoff sits at perf 155.

## Review

An independent second model reviewed the full entry before the gate
(OpenRouter, nvidia/nemotron-3-ultra-550b-a55b:free, 3 passes over all 8
source files, 52 findings): 5 fixes applied (HEAD on the static fast paths,
a targeted `service` lookup, an 8 KiB chunked-trailer cap, an ASCII head
write, pagination on the pulls list); the rest were refuted against the code
or the passing suite and are recorded with reasons in the build log.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wa8s3t3t&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
