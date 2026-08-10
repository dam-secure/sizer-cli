# Dam Secure Sizer

Dam Secure Sizer is a customer-run Docker tool for producing the repository
facts Dam Secure needs to size your repos. You run it on your own machine, then
decide whether to share the resulting CSV with Dam Secure.

The tool does not run in Dam Secure infrastructure, does not phone home, and
does not give Dam Secure access to your repositories. It emits pull-request
activity windows, file-count facts, and commit activity.

## Safety Highlights

- Nothing contacts Dam Secure servers. The container only talks to GitHub:
  `api.github.com` to enumerate repos and pull requests, and `github.com` to
  fetch git metadata.
- Repositories are not fully cloned or checked out. The sizer uses partial
  clones with `--filter=blob:none --no-checkout`, so it fetches `.git` tree and
  commit metadata, not source file contents.
- Temporary git data lives inside the container and is deleted as each repo
  finishes.
- The output is a facts-only CSV/table: pull-request stats, file counts,
  exclusions, activity, and diagnostics. It contains no pricing logic.

## What You Need

- Docker, Docker Desktop, Colima, Podman, or another Docker-compatible runtime.
- A GitHub personal access token with read access to the repositories you want
  sized (see [Authentication](#authentication) for the exact permissions).
- Network access from the container to `api.github.com` and `github.com`.

## Quick Start

Create a GitHub PAT with the permissions below, then:

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
prompt can receive input. Only default-included repos appear (archived, forks,
and empty repos stay excluded, including after invert):

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

1. Open [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
2. Set **Resource owner** to your user (or the org, if allowed).
3. Under **Repository access**, choose **All repositories**, or **Only select
   repositories** for the repos you want sized.
4. Under **Permissions → Repository permissions**, set exactly:

   | Permission | Access |
   |---|---|
   | **Metadata** | Read-only (required; usually auto-selected) |
   | **Contents** | Read-only |
   | **Pull requests** | Read-only |

   Leave every other permission as **No access**. Do not grant write access.
5. Generate the token, copy it, and export it as `GHPAT`.

What each permission is for:

- **Metadata** — list repositories (`GET /user/repos`).
- **Contents** — partial clone + file counts / commit activity.
- **Pull requests** — PR counts and size fields (`changed_files`, `additions`,
  `deletions`).

Permission reference:
https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

After the run, revoke the token:
https://github.com/settings/personal-access-tokens

Classic PATs also work with `repo` (private) or `public_repo` (public only),
but fine-grained tokens are preferred.

## Output

CSV is the artifact to share. A table is used when no `--output` is
provided.

```bash
--output /out/sized.csv        # CSV
--format csv                  # force CSV
--format table                # force terminal table
```

The CSV includes identity, pull-request windows, file sizing, activity, and
diagnostics:

```text
full_name, size_kb, last_pr_at,
prs_last_1w, prs_last_4w, prs_last_3m, prs_last_12m, prs_last_24m,
pr_authors_last_1w, pr_authors_last_4w, pr_authors_last_3m,
pr_authors_last_12m, pr_authors_last_24m,
total_files, excluded_global, excluded_repo, counted_files,
truncated, has_damsecure_ignore, damsecure_ignore_lines,
last_commit_at, commits_last_4w, commits_last_13w, commits_last_52w,
committers_last_4w, committers_last_13w, committers_last_52w,
activity_unavailable, error
```

PR windows are cumulative counts of PRs created in the last 1 week, 4 weeks,
3 months, 12 months, and 24 months. Month windows use 30-day months
(90 / 365 / 730 days). If pull-request data cannot be loaded (usually missing
**Pull requests: Read** on the PAT), the run fails immediately with a loud
error — it does not soft-fail with empty PR columns.

Example terminal table:

```text
[sizer] done — 12 repos sized in 16.1s
REPO                 PRS_1W  PRS_4W  PRS_3M  PRS_12M  PRS_24M  AUTHORS_4W  COUNTED  COMMITTERS_4W  LAST_PR
-------------------  ------  ------  ------  -------  -------  ----------  -------  -------------  ----------
acme/platform-api         4      12      40      160      184           4    1,368             11  2026-05-13
acme/customer-portal      1       3      10       38       42           2      247              1  2026-04-23
-------------------  ------  ------  ------  -------  -------  ----------  -------  -------------  ----------
TOTAL                     —       —       —        —      226           —    1,615              —           —
```

## How Sizing Works

For each included repository, the sizer:

1. Enumerates repositories through the GitHub API.
2. Fetches all pull requests via the GitHub GraphQL API (open, closed, and
   merged).
3. Aggregates PR and author counts over 1w / 4w / 3m / 12m / 24m windows.
4. Partial-clones each selected repo with `--filter=blob:none --no-checkout`.
5. Counts paths from git tree metadata.
6. Applies Dam Secure's global ignore patterns.
7. Applies repo-local `.damsecure-ignore` patterns if present.
8. Computes recent commit activity from `git log`.
9. Deletes the temporary clone.

## Privacy

- The tool contacts GitHub only: `api.github.com` for enumeration and PR
  metadata, and `github.com` for cloning.
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
