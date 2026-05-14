# Dam Secure Sizer

Dam Secure Sizer is a customer-run Docker tool for producing the repository
facts Dam Secure needs to size your repos. You run it on your own machine, then
decide whether to share the resulting CSV with Dam Secure.

The tool does not run in Dam Secure infrastructure, does not phone home, and
does not give Dam Secure access to your repositories. It only emits file-count
and activity facts.

## Safety Highlights

- Nothing contacts Dam Secure servers. The container only talks to GitHub:
  `api.github.com` to enumerate repos and `github.com` to fetch git metadata.
- Repositories are not fully cloned or checked out. The sizer uses partial
  clones with `--filter=blob:none --no-checkout`, so it fetches `.git` tree and
  commit metadata, not source file contents.
- Temporary git data lives inside the container and is deleted as each repo
  finishes.
- The output is a facts-only CSV/table: file counts, exclusions, activity, and
  diagnostics. It contains no pricing logic.

## What You Need

- Docker, Docker Desktop, Colima, Podman, or another Docker-compatible runtime.
- A GitHub personal access token with read access to the repositories you want
  sized.
- Network access from the container to `api.github.com` and `github.com`.

## Quick Start

Create a GitHub PAT with read access to the repositories you want sized, then:

```bash
export GHPAT=github_pat_...

docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --quiet \
  --format csv > sized.csv
```

By default, the sizer considers all repositories visible to the GitHub token.
Look at `sized.csv` and send it to your Dam Secure contact.

## Examples

Preview the repos that would be considered, without cloning anything:

```bash
docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --list-only > repos.csv
```

Restrict enumeration to one GitHub owner, which can be either an organization or
personal account:

```bash
docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --scope <owner>
```

Run an interactive checkbox prompt before sizing. Docker needs `-it` so the
prompt can receive input:

```bash
docker run --rm -it \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --interactive
```

The prompt is written to stderr, keeping redirected CSV output clean.

Skip specific repositories before cloning. `--ignore-repos` uses exact
`owner/repo` names:

```bash
docker run --rm \
  -e GHPAT \
  ghcr.io/dam-secure/sizer-cli:latest \
  --ignore-repos <owner>/legacy,<owner>/demo
```

Write directly from the container to a mounted output directory:

```bash
docker run --rm \
  -e GHPAT \
  -v "$PWD:/out" \
  ghcr.io/dam-secure/sizer-cli:latest \
  --output /out/sized.csv
```

See all CLI options:

```bash
docker run --rm ghcr.io/dam-secure/sizer-cli:latest --help
```

## Run From Source

Use this when you want to inspect or modify the code instead of using the
published Docker image.

```bash
gh repo clone dam-secure/sizer-cli
cd sizer-cli
npm ci
export GHPAT=github_pat_...

npm run --silent dev -- --format csv > sized.csv
```

Add `--scope <owner>` if you want to restrict the repository set to one GitHub
organization or personal account.

Build and test the Docker image locally:

```bash
docker build -t damsecure-sizer:local .
docker run --rm damsecure-sizer:local --help
```

## Authentication

The container reads the GitHub token from `GHPAT`, or from `--token <pat>` if
you prefer to pass it as a CLI option.

Recommended:

```bash
export GHPAT=github_pat_...
docker run --rm -e GHPAT ghcr.io/dam-secure/sizer-cli:latest --help
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

Example terminal table:

```text
[sizer] done — 12 repos sized in 16.1s
REPO                         FILES  EXCL_GLOBAL  EXCL_REPO  COUNTED  COMMITTERS_4W  COMMITTERS_13W  COMMITTERS_52W  PUSHED
---------------------------  -----  -----------  ---------  -------  -------------  --------------  --------------  ----------
acme/platform-api            1,427           59          0    1,368             11              14              16  2026-05-13
acme/customer-portal           267           20          0      247              1               1               1  2026-04-23
acme/worker-service            149            2          0      147              1               2               2  2026-05-13
acme/mobile-app                 87            1          0       86              2               2               2  2026-05-08
acme/docs-site                  32            0          0       32              2               2               2  2026-05-08
acme/legacy-admin               30            1          0       29              0               0               3  2025-07-27
acme/design-system              24            1          0       23              0               1               1  2026-02-25
acme/example-go                 15            2          0       13              0               0               1  2025-11-19
acme/example-python              6            0          0        6              0               0               1  2025-11-20
acme/empty-repo                  0            0          0        0              —               —               —  2026-02-05
---------------------------  -----  -----------  ---------  -------  -------------  --------------  --------------  ----------
TOTAL                        2,037           86          0    1,951              —               —               —           —
```

## How Sizing Works

For each included repository, the sizer:

1. Enumerates repositories through the GitHub API.
2. Partial-clones each selected repo with `--filter=blob:none --no-checkout`.
3. Counts paths from git tree metadata.
4. Applies Dam Secure's global ignore patterns.
5. Applies repo-local `.damsecure-ignore` patterns if present.
6. Computes recent activity from `git log`.
7. Deletes the temporary clone.

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

If `--scope` is omitted, the sizer considers all repos visible to the
authenticated PAT. Use `--scope <owner>` to keep only repos whose full name
starts with `<owner>/`, for example `dam-secure/backend` or
`patrickcollins12/repo1`.

Run `--help` to see every supported option:

```bash
docker run --rm ghcr.io/dam-secure/sizer-cli:latest --help
```

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

## Not yet implemented

- AI-driven production exclusions
- SLOC or per-language breakdowns
- GitHub App authentication
- GitLab, Bitbucket, and Azure DevOps execution in v1

## License

MIT. See [LICENSE](./LICENSE).
