# Releasing

Two things that look like one and are not:

| | when | what it is |
|---|---|---|
| **tag** | every version | the durable record of what was built |
| **GitHub Release** | minor bumps only | an announcement that something changed |

## Tags: every version

Every version gets an annotated tag, including versions that were never
deployed and versions that failed. `scripts/deploy.py` packs from a tag, so a
deployed build without one cannot be identified afterwards.

**Tags are never retargeted or deleted.** `v0.3.0` points at a build whose
first deployment failed plugin registration; `v0.3.2` and `v0.3.3` point at
builds the deployment gate rejected. Those are accurate and they stay. Moving a
tag to a fixed commit erases the only durable evidence of what was actually
built and shipped, and the fixed build is a new version anyway.

## Releases: minor bumps only

Publish a GitHub Release when the minor version moves — `v0.4.0`, `v0.5.0`,
`v1.0.0`. Patch versions get a tag and a CHANGELOG entry and nothing else.

A minor bump here has meant a real capability or contract change:

```
0.2.0   evidence capture introduced
0.3.0   a model call added to the turn lifecycle
```

Everything between those has been repair and instrumentation. Seven releases
were published across one afternoon of 0.2.x and 0.3.x work, and "evidence
capture reports a skip reason slightly differently" is not something anybody
needs announced. The notes at a minor boundary tell the whole story of the line,
which reads better than the fragments did.

Already-published patch releases stay published, for the same reason tags do.

## Cutting a version

```bash
# 1. version files and changelog, in the same commit as the work
npm version 0.4.0 --no-git-tag-version   # there is no lockfile
$EDITOR openclaw.plugin.json CHANGELOG.md # manifest version, changelog entry

# 2. verify before anything leaves the machine
npm test                  # as a non-root user: two tests are skipped for root
npm run check:types       # twice — it must be idempotent
npm run example

# 3. commit, push, and require green CI on that exact commit
git commit -am "0.4.0: ..."
git push origin main

# 4. only then tag, and only the commit CI passed on
git tag -a v0.4.0 -m "..."
git push origin v0.4.0
```

`npm version` is run with `--no-git-tag-version` deliberately: letting it create
its own tag collides with the annotated one, and the packed artifact must
already identify as the new version before it is tagged.

## Deploying

```bash
git archive v0.4.0 | tar -x -C /path/to/deploy/llm-grounded-<commit>
python3 scripts/deploy.py \
  --artifact /path/to/deploy/llm-grounded-<commit> \
  --version 0.4.0 \
  --epoch v0.4.0-<what-changed>
```

The script preflights the artifact against the exact config it is about to
write, then verifies after the restart that the host actually loaded it, and
restores the previous artifact path *and* the previous config keys if not.

The invariant it exists for:

```
a successful gateway restart is not a successful plugin deployment
```

0.3.0 restarted the gateway perfectly and came up with the plugin absent —
registration threw, so grounding, the voice contract and evidence capture were
all silently off, and the only sign was one line in a log nobody was tailing.

Bump `behaviorEpoch` whenever behaviour changes, and leave it alone when it does
not. It is what separates one regime's telemetry from another's, and a corpus
spanning a boundary is only readable because of it.
