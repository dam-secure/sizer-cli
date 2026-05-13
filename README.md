# @damsecure/sizer

Produce a sizing + activity **fact sheet** for your GitHub repositories that
Dam Secure can use to quote pricing — without giving us access to your code.

This tool emits **facts** (file counts after standard exclusions, recent
commit/contributor activity). It does **not** compute pricing. You send the
CSV to your Dam Secure contact and they apply pricing math on their side.
That separation is deliberate: pricing can change without you re-running
anything.

---

## Install

Download the standalone binary for your platform from the latest GitHub
Release. The only runtime requirement is `git` 2.22+ on PATH.

```bash
# macOS arm64 (Apple Silicon)
curl -fsSL https://github.com/dam-secure/sizer-cli/releases/latest/download/damsecure-sizer-darwin-arm64 -o damsecure-sizer
chmod +x damsecure-sizer
./damsecure-sizer --help
```

```bash
# Linux x64
curl -fsSL https://github.com/dam-secure/sizer-cli/releases/latest/download/damsecure-sizer-linux-x64 -o damsecure-sizer
chmod +x damsecure-sizer
./damsecure-sizer --help
```

Builds available for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`.
SHA256 checksums are attached to each release as
`damsecure-sizer-checksums.txt`.

---

## Workflow

### Two-step (recommended)

```bash
# 1. Pull the list of repositories in your org. CHEAP — no clones, no code
#    fetched. The output CSV has an `included` column you can edit.
./damsecure-sizer list \
    --scope org=acme \
    --token $GITHUB_TOKEN \
    --output repos.csv

# 2. Open repos.csv in Excel / Sheets. Flip the `included` column to FALSE
#    for any repo you don't want measured. Save.

# 3. Size only the included repos. Each one is partial-cloned to a temp dir,
#    measured, and deleted. Local disk peak ≈ concurrency × ~10 MB.
./damsecure-sizer size \
    --from repos.csv \
    --token $GITHUB_TOKEN \
    --output sized.csv

# 4. Email sized.csv to your Dam Secure contact.
```

### One-shot (faster, less auditable)

```bash
./damsecure-sizer all --scope org=acme --token $GITHUB_TOKEN --output sized.csv
```

Add `--interactive` to get a checkbox prompt to deselect repos between the
list step and the size step.

---

## Authentication

The tool reads a GitHub personal access token (PAT) from `--token` or the
environment variable `DAMSECURE_SIZER_GITHUB_TOKEN`.

> **Why a PAT and not a GitHub App?** A buyer running this tool has not
> installed Dam Secure yet, by design — the whole point is to get a quote
> before granting access. A GitHub App would require installing the App
> into your org first, which contradicts that. We're tracking a
> short-lived-credential alternative for buyers who have already engaged
> Dam Secure (see "Credential model" below).

### Fine-grained PAT (recommended)

1. https://github.com/settings/personal-access-tokens/new
2. **Expiration**: pick the **shortest period that fits your sales cycle**
   — 30 days is recommended; never select "No expiration".
3. **Repository access**: All repositories (or select the target org's
   repos). Choose the narrowest set that includes everything you want sized.
4. **Permissions ▸ Repository ▸ Contents**: Read-only — required.
5. **Permissions ▸ Repository ▸ Metadata**: Read-only (auto-included) — required.
6. Do not grant any other permission. The tool only ever lists repos and
   reads tree+commit metadata; everything else is unnecessary attack surface.
7. Generate, copy, then `export DAMSECURE_SIZER_GITHUB_TOKEN=<pat>`
   (recommended) or pass via `--token <pat>` on the command line.

### Classic PAT (fallback)

Scope `repo` (private repos) or `public_repo` (public only). Classic PATs
do not enforce a Contents+Metadata-only boundary, so we strongly prefer
fine-grained.

### After the run: revoke the token

Once you've sent `sized.csv` to your Dam Secure contact, **revoke the PAT
immediately**:

1. https://github.com/settings/personal-access-tokens
2. Find the token you just used.
3. **Revoke**.

This is the single most effective control: a revoked token can't be
re-used by anything that scraped it from a shell history, an Excel
auto-recover file, or a forwarded email.

### Credential model — annual review

We use static PATs for v1 because no GitHub short-lived alternative fits
the unauthenticated-buyer trust model (App installation requires
pre-installation; OAuth device flow needs a Dam Secure-controlled
callback that contradicts our "nothing phones home" promise). This
decision is **re-evaluated at least once every 12 months** alongside the
rest of the monorepo's annual security review. Last review: **2026-05-13**
(initial release of `@damsecure/sizer`). Next due: **2027-05-13**.

---

## Output formats

`size` writes CSV by default (when `--output` is set) and a pretty terminal
table to stdout otherwise. Override with `--format`:

| Format | Default when                 | Use case                                               |
|--------|------------------------------|--------------------------------------------------------|
| `csv`  | `--output FILE`              | The deliverable you send to Dam Secure                 |
| `json` | `--output FILE.json`         | Audit / debug / chart in Sheets pivot tools            |
| `table`| no `--output`                | Eyeball the result before sharing                      |

The CSV is the canonical share-with-sales artifact; JSON adds a schema
version + generation timestamp for traceability.

---

## What's in the sized CSV

Identity columns (copied from the list CSV) + sizing + activity:

```
full_name, default_branch, size_kb, pushed_at, note,
commit_sha, total_files, excluded_global, excluded_repo, counted_files,
truncated, has_damsecure_ignore, damsecure_ignore_lines,
last_commit_at, commits_last_4w, commits_last_13w, commits_last_52w,
committers_last_4w, committers_last_13w, committers_last_52w,
top_contributors, activity_unavailable, error
```

**Explicitly absent:** `tier`, `credits`, `cost`, `price`, or any pricing
label. The sizer reports facts; sales runs whatever pricing math is
current at quote time on its side.

The identity invariant the CSV depends on:

```
total_files == counted_files + excluded_global + excluded_repo
```

---

## How file counts are computed

Two sources of exclusions, both required and matching production:

1. **Global** — patterns from the vendored `ignorefile.txt`, kept aligned
   with the production scanner's global ignore file. Embedded into the binary
   at build time so the JS build and static binary apply identical patterns.
   Counted in `excluded_global`.
2. **Per-repo** — patterns from `.damsecure-ignore` at the analysed commit
   (read via `git show HEAD:.damsecure-ignore`; missing file is the common
   case and not an error). Counted in `excluded_repo`.

A path matched by both is attributed to `excluded_global` only — never
double-counted.

### Worst-case framing

`counted_files` is the **worst case** before AI-driven per-project
exclusions. In production, AI exclusions typically reduce this by an
**additional 30–60%**. We do not try to replicate the AI model in this
tool — that's a deliberate trade-off so you can quote without granting
us code access. If you want a less-conservative number, install Dam Secure
properly and run a real scan; otherwise the number here is the safe
upper bound.

---

## How activity is computed

A single `git log --since=52.weeks.ago --pretty=%H%x09%an%x09%cI` pass
against the partial clone, then bucketed client-side into 4-week, 13-week,
and 52-week windows. `last_commit_at` comes from
`git log -1 --format=%cI HEAD`. No GitHub API calls — works identically
on any git host (planned for v2 with GitLab / Bitbucket / Azure DevOps).

If `git log` fails (extremely rare on a clean partial clone), the row's
activity columns are all `-1` and `activity_unavailable` is `true`. The
rest of the row (file counts) is unaffected.

> Caveat: `git log --since=<date>` uses a traversal optimisation that can
> stop walking past commits with old committer dates. Real-world repos
> with the newest commit at HEAD aren't affected; a repo that recently
> fast-forwarded an ancient backport branch onto HEAD might under-report.

---

## Privacy

- **Nothing phones home.** The sizer's only outbound traffic is to
  `api.github.com` (to enumerate your repos) and to `github.com` over
  HTTPS (to clone). Neither destination is owned by Dam Secure.
- **Your code never leaves your machine** *unless you choose to share the
  CSV*. The CSV contains aggregate counts and committer names — no source
  code, no diff content, no file contents.
- **No source code is written to disk.** Partial clones use
  `--filter=blob:none --no-checkout`, so trees and commit metadata are
  fetched but blob contents are not. Clones live under
  `${TMPDIR}/damsecure-sizer-<pid>/<repo>` and are deleted after each
  repo is measured (or when the process exits).
- **The PAT is never logged.** A redactor wraps `process.stdout.write` and
  `process.stderr.write` to scrub `x-access-token:<token>@` from any string
  that might leak through dependency code we don't control. The PAT is
  never written to disk outside the to-be-deleted `.git/config`.

---

## Reproducibility

This tool is open source in the
[`dam-secure/sizer-cli`](https://github.com/dam-secure/sizer-cli).
Security-conscious customers can:

- Read the source.
- Build the static binary themselves with `npm run build:binary` (requires Bun).
- Verify SHA256 checksums attached to every GitHub release.

---

## Reference

### Subcommands

```
damsecure-sizer list  --scope <spec> [--token <pat>] [--output <path>] [--include-archived] [--include-forks]
damsecure-sizer size  (--from <csv> | --scope <spec>) [--token <pat>] [--output <path>] [--format csv|json|table] [--no-activity] [--concurrency <n>]
damsecure-sizer all   --scope <spec> [--token <pat>] [--output <path>] [--format csv|json|table] [--interactive] [--no-activity] [--concurrency <n>]
```

### Scope syntax

```
org=acme                  GitHub org "acme" (default provider when no prefix)
github:org=acme           same, explicit provider prefix
user                      repos visible to the authenticated PAT
github:user               same, explicit
gitlab:group=foo          (planned for v2 — currently throws "not implemented")
bitbucket:workspace=foo   (planned for v2)
azure:org=foo             (planned for v2)
```

### Defaults

| Flag                    | Default | Notes                                                  |
|-------------------------|---------|--------------------------------------------------------|
| `--concurrency`         | 5       | Per-repo parallelism in `size`                         |
| `--no-activity`         | off     | Activity columns are on by default                     |
| `--include-archived`    | on      | Archived repos appear with `included=false`            |
| `--include-forks`       | on      | Fork repos appear with `included=false`                |
| `--interactive` (`all`) | off     | Add a checkbox prompt between list and size            |
| `--debug` (top-level)   | off     | Print stack traces and underlying caught errors to stderr. We deliberately suppress these by default so the CLI doesn't leak internal paths or dependency-internal details. Add the flag when filing an issue. |

### Runtime

- The released static binary for your platform.
- `git` 2.22+ on PATH.

---

## Out of scope (v1)

- Any pricing logic — no tiers, no credits, no "Small/Medium/Large" labels.
- AI-driven per-project exclusions (deliberate trade-off — see above).
- GitLab, Bitbucket, Azure DevOps (interface in place, stubs throw).
- SLOC / per-language breakdown.
- GitHub App–based variant.

---

## License

MIT. See [LICENSE](./LICENSE).
