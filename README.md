# Dam Secure Sizer

Dockerized GitHub repository sizing for Dam Secure repo sizing. The tool emits a
CSV fact sheet with file counts and recent commit activity. It does **not** send data to Dam Secure, you will need to do that yourself.

## What You Need

- Docker, Docker Desktop, Colima, Podman, or another Docker-compatible runtime.
- A GitHub personal access token with read access to the repositories you want
  sized.
- Network access from the container to `api.github.com` and `github.com`.

## Quick Start

```bash
export GHPAT=github_pat_...

docker run --rm \
  -e GHPAT \
  -v "$PWD:/out" \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope org=acme \
  --output /out/sized.csv
```

The command writes `sized.csv` into your current directory. Look at that file and send that CSV to your Dam Secure contact.

Use a pinned release instead of `latest` when you need repeatability:

```bash
ghcr.io/dam-secure/sizer-cli:v0.1.0
```

## Common Commands

Preview the repos that would be considered, without cloning anything:

```bash
docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope org=acme \
  --list-only > repos.csv
```

Run an interactive checkbox prompt before sizing:

```bash
docker run --rm -it \
  -e GHPAT \
  -v "$PWD:/out" \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope org=acme \
  --interactive \
  --output /out/sized.csv
```

Skip specific repositories before cloning:

```bash
docker run --rm \
  -e GHPAT \
  -v "$PWD:/out" \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope org=acme \
  --ignore-repos acme/legacy,acme/demo \
  --output /out/sized.csv
```

Print a terminal table instead of writing CSV:

```bash
docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope org=acme
```

## Authentication

The container reads the GitHub token from `GHPAT`, or from `--token <pat>` if
you prefer to pass it as a CLI option.

Recommended:

```bash
export GHPAT=github_pat_...
docker run --rm -e GHPAT ghcr.io/dam-secure/sizer-cli:latest --scope org=acme --list-only
```

Avoid putting the token directly in the `docker run` command if your shell
history is retained.

### Fine-Grained PAT

Create a fine-grained token at:

https://github.com/settings/personal-access-tokens/new

Use the narrowest repository access that includes everything you want sized.
Grant only:

- Repository contents: read-only
- Repository metadata: read-only

After the run, revoke the token:

https://github.com/settings/personal-access-tokens

Classic PATs also work with `repo` for private repositories or `public_repo` for
public repositories, but fine-grained tokens are preferred.

## Output

CSV is the artifact to share. A table is used when no `--output` is
provided.

```bash
--output /out/sized.csv        # CSV
--format csv                  # force CSV
--format table                # force terminal table
```

The CSV includes identity, sizing, activity, and diagnostics:

```text
full_name, default_branch, size_kb, pushed_at, note,
commit_sha, total_files, excluded_global, excluded_repo, counted_files,
truncated, has_damsecure_ignore, damsecure_ignore_lines,
last_commit_at, commits_last_4w, commits_last_13w, commits_last_52w,
committers_last_4w, committers_last_13w, committers_last_52w,
top_contributors, activity_unavailable, error
```

It never includes pricing fields such as `tier`, `credits`, `cost`, or `price`.

## How Sizing Works

For each included repository, the sizer:

1. Enumerates repositories through the GitHub API.
2. Partial-clones each selected repo with `--filter=blob:none --no-checkout`.
3. Counts paths from git tree metadata.
4. Applies Dam Secure's global ignore patterns.
5. Applies repo-local `.damsecure-ignore` patterns if present.
6. Computes recent activity from `git log`.
7. Deletes the temporary clone.

The core invariant is:

```text
total_files == counted_files + excluded_global + excluded_repo
```

`counted_files` is intentionally conservative. It is a worst-case estimate
before production AI exclusions, which often reduce the final billable set.

## Privacy

- The tool contacts GitHub only: `api.github.com` for enumeration and
  `github.com` for cloning.
- Nothing phones home to Dam Secure.
- Source blobs are not checked out. The clone fetches tree and commit metadata.
- Temporary clones live inside the container and are deleted after each repo.
- The only host write in normal use is the mounted output CSV path.
- The PAT is redacted from stdout/stderr if dependency output ever includes an
  authenticated clone URL.

## Scopes

```text
org=acme                  GitHub org "acme"
github:org=acme           same, explicit provider prefix
user                      repos visible to the authenticated PAT
github:user               same, explicit provider prefix
gitlab:group=foo          planned, currently not implemented
bitbucket:workspace=foo   planned, currently not implemented
azure:org=foo             planned, currently not implemented
```

## Options

```text
--scope <spec>                 required scope, e.g. org=acme
--token <pat>                  GitHub PAT; overrides GHPAT
--output <path>                write result to a file
--format csv|table             output format
--list-only                    print repo list CSV and skip cloning
--interactive                  prompt before sizing
--ignore-repos owner/repo,...  exact repo full names to skip
--no-activity                  skip git log activity analysis
--concurrency <n>              repo parallelism, default 5
--no-include-archived          drop archived repos from enumeration
--no-include-forks             drop fork repos from enumeration
--quiet                        suppress progress output
--debug                        print stack traces and suppressed error details
```

`--ignore-repos` uses exact full-name matching only. It does not support glob
patterns.

## Reproducibility

Published images are available at:

```text
ghcr.io/dam-secure/sizer-cli:latest
ghcr.io/dam-secure/sizer-cli:vX.Y.Z
```

Security-conscious users can pin an image digest:

```bash
docker pull ghcr.io/dam-secure/sizer-cli@sha256:<digest>
```

They can also build from source:

```bash
docker build -t damsecure-sizer .
docker run --rm damsecure-sizer --help
```

## Out Of Scope

- Pricing logic
- AI-driven production exclusions
- SLOC or per-language breakdowns
- GitHub App authentication
- GitLab, Bitbucket, and Azure DevOps execution in v1

## License

MIT. See [LICENSE](./LICENSE).
