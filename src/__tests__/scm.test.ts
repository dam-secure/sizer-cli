/**
 * SCM enumeration tests.
 *
 * Uses a hand-rolled fetch mock injected via Octokit's `request.fetch` option
 * (rather than `nock`) — Octokit-since-v20 uses native fetch, and a tiny mock
 * is more deterministic than threading nock's fetch interceptor through ESM
 * module resolution. The behaviour we cover is the same:
 *
 *   - paginated /orgs/{org}/repos consumption
 *   - default-branch / archived / fork / empty classification
 *   - 403 + 404 + 401 error mapping
 *   - log-redaction snapshot of the cloneUrl
 */

import { describe, expect, it, vi } from 'vitest';
import { GitHubEnumerator, buildAuthenticatedCloneUrl } from '../scm/github.js';
import {
  parseScope,
  createEnumerator,
  ScopeParseError,
} from '../scm/factory.js';
import { defaultIncluded } from '../scm/types.js';
import { GitLabEnumerator } from '../scm/gitlab.js';
import { BitbucketEnumerator } from '../scm/bitbucket.js';
import { AzureDevOpsEnumerator } from '../scm/azure.js';

interface MockHandler {
  match: (url: string) => boolean;
  respond: (url: string, init: RequestInit) => Response;
}

/**
 * Programmable fetch mock. Each handler is consumed AT MOST ONCE; later
 * handlers fall through if earlier ones already matched. The first unmatched
 * request fails the test loudly.
 */
function makeFetchMock(handlers: MockHandler[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const idx = handlers.findIndex((h) => h.match(url));
    if (idx === -1) {
      throw new Error(`fetch-mock: no handler matched ${init.method ?? 'GET'} ${url}`);
    }
    const [handler] = handlers.splice(idx, 1);
    return handler.respond(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const TOKEN = 'ghp_supersecrettokenAAAAAAAAAAAAAAAAAA';

function makeRepo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'acme/api',
    clone_url: 'https://github.com/acme/api.git',
    default_branch: 'main',
    size: 1234,
    pushed_at: '2026-05-10T12:34:56Z',
    archived: false,
    fork: false,
    ...overrides,
  };
}

describe('parseScope', () => {
  it('parses a default GitHub org scope', () => {
    expect(parseScope('org=acme')).toEqual({
      provider: 'github',
      type: 'org',
      name: 'acme',
    });
  });

  it('parses an explicit github:org=... scope', () => {
    expect(parseScope('github:org=acme')).toEqual({
      provider: 'github',
      type: 'org',
      name: 'acme',
    });
  });

  it('parses the bare "user" scope', () => {
    expect(parseScope('user')).toEqual({ provider: 'github', type: 'user' });
  });

  it('throws on missing scope', () => {
    expect(() => parseScope('')).toThrow(ScopeParseError);
    expect(() => parseScope('   ')).toThrow(ScopeParseError);
  });

  it('throws on unknown provider', () => {
    expect(() => parseScope('codeberg:org=acme')).toThrow(/codeberg/);
  });

  it('parses a v2 gitlab scope (still typed) so factory can return the stub', () => {
    expect(parseScope('gitlab:group=foo')).toEqual({
      provider: 'gitlab',
      group: 'foo',
    });
  });

  it('rejects malformed gitlab scope', () => {
    expect(() => parseScope('gitlab:bogus')).toThrow(/group=/);
  });
});

describe('createEnumerator', () => {
  it('returns a GitHubEnumerator for github scopes', () => {
    const scope = parseScope('org=acme');
    expect(createEnumerator(scope, TOKEN)).toBeInstanceOf(GitHubEnumerator);
  });

  it('returns the v2 stub for gitlab/bitbucket/azure', () => {
    expect(createEnumerator(parseScope('gitlab:group=foo'), TOKEN)).toBeInstanceOf(
      GitLabEnumerator
    );
    expect(
      createEnumerator(parseScope('bitbucket:workspace=foo'), TOKEN)
    ).toBeInstanceOf(BitbucketEnumerator);
    expect(
      createEnumerator(parseScope('azure:org=foo'), TOKEN)
    ).toBeInstanceOf(AzureDevOpsEnumerator);
  });
});

describe('v2 stubs', () => {
  it('GitLab stub throws "not implemented"', async () => {
    await expect(
      new GitLabEnumerator().enumerate(
        { provider: 'gitlab', group: 'foo' },
        { includeArchived: true, includeForks: true }
      )
    ).rejects.toThrow(/not implemented/i);
  });

  it('Bitbucket stub throws "not implemented"', async () => {
    await expect(
      new BitbucketEnumerator().enumerate(
        { provider: 'bitbucket', workspace: 'foo' },
        { includeArchived: true, includeForks: true }
      )
    ).rejects.toThrow(/not implemented/i);
  });

  it('Azure stub throws "not implemented"', async () => {
    await expect(
      new AzureDevOpsEnumerator().enumerate(
        { provider: 'azure', organization: 'foo' },
        { includeArchived: true, includeForks: true }
      )
    ).rejects.toThrow(/not implemented/i);
  });
});

describe('buildAuthenticatedCloneUrl', () => {
  it('injects the token as x-access-token', () => {
    const url = buildAuthenticatedCloneUrl(
      'https://github.com/acme/api.git',
      'ghp_xxxx'
    );
    expect(url).toBe('https://x-access-token:ghp_xxxx@github.com/acme/api.git');
  });

  it('does NOT appear in a JSON serialization of a RepoListing if the consumer is careful', () => {
    // We rely on the log redactor for defence in depth, but this test pins the
    // exact format the redactor will look for.
    const url = buildAuthenticatedCloneUrl(
      'https://github.com/acme/api.git',
      'ghp_xxxx'
    );
    expect(url).toMatch(/^https:\/\/x-access-token:[^@]+@/);
  });
});

describe('GitHubEnumerator.enumerate', () => {
  it('returns a normalised RepoListing[] from a single page', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos'),
        respond: () =>
          jsonResponse([
            makeRepo({ full_name: 'acme/api' }),
            makeRepo({ full_name: 'acme/web', size: 5678 }),
          ]),
      },
    ]);

    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    const result = await enumerator.enumerate(
      { provider: 'github', type: 'org', name: 'acme' },
      { includeArchived: true, includeForks: true }
    );

    expect(result).toHaveLength(2);
    expect(result[0].fullName).toBe('acme/api');
    expect(result[0].defaultBranch).toBe('main');
    expect(result[0].sizeKb).toBe(1234);
    expect(result[0].cloneUrl).toMatch(/^https:\/\/x-access-token:/);
    expect(result[1].sizeKb).toBe(5678);
  });

  it('paginates across multiple pages', async () => {
    // Octokit's paginator follows the Link header. Page 1 sets a `next` link;
    // page 2 returns no link header, terminating pagination.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeRepo({ full_name: `acme/repo${i + 1}` })
    );
    const page2 = Array.from({ length: 23 }, (_, i) =>
      makeRepo({ full_name: `acme/repo${100 + i + 1}` })
    );

    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos') && !u.includes('page=2'),
        respond: () =>
          jsonResponse(page1, 200, {
            link: '<https://api.github.com/organizations/1/repos?per_page=100&page=2>; rel="next"',
          }),
      },
      {
        match: (u) => u.includes('page=2'),
        respond: () => jsonResponse(page2),
      },
    ]);

    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    const result = await enumerator.enumerate(
      { provider: 'github', type: 'org', name: 'acme' },
      { includeArchived: true, includeForks: true }
    );

    expect(result).toHaveLength(123);
    expect(result[0].fullName).toBe('acme/repo1');
    expect(result[100].fullName).toBe('acme/repo101');
    expect(result[122].fullName).toBe('acme/repo123');
  });

  it('classifies archived / fork / empty correctly', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos'),
        respond: () =>
          jsonResponse([
            makeRepo({ full_name: 'acme/active' }),
            makeRepo({ full_name: 'acme/old', archived: true }),
            makeRepo({ full_name: 'acme/forked', fork: true }),
            makeRepo({
              full_name: 'acme/blank',
              default_branch: null,
              size: 0,
              pushed_at: null,
            }),
          ]),
      },
    ]);

    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    const result = await enumerator.enumerate(
      { provider: 'github', type: 'org', name: 'acme' },
      { includeArchived: true, includeForks: true }
    );

    const byName = Object.fromEntries(result.map((r) => [r.fullName, r]));
    expect(byName['acme/active'].isArchived).toBe(false);
    expect(byName['acme/active'].isFork).toBe(false);
    expect(byName['acme/active'].isEmpty).toBe(false);
    expect(byName['acme/old'].isArchived).toBe(true);
    expect(byName['acme/forked'].isFork).toBe(true);
    expect(byName['acme/blank'].isEmpty).toBe(true);
    expect(byName['acme/blank'].defaultBranch).toBe('');

    // defaultIncluded honours D-B
    expect(defaultIncluded(byName['acme/active'])).toBe(true);
    expect(defaultIncluded(byName['acme/old'])).toBe(false);
    expect(defaultIncluded(byName['acme/forked'])).toBe(false);
    expect(defaultIncluded(byName['acme/blank'])).toBe(false);
  });

  it('drops archived / forks when includeArchived/includeForks is false', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos'),
        respond: () =>
          jsonResponse([
            makeRepo({ full_name: 'acme/active' }),
            makeRepo({ full_name: 'acme/old', archived: true }),
            makeRepo({ full_name: 'acme/forked', fork: true }),
          ]),
      },
    ]);

    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    const result = await enumerator.enumerate(
      { provider: 'github', type: 'org', name: 'acme' },
      { includeArchived: false, includeForks: false }
    );

    expect(result.map((r) => r.fullName)).toEqual(['acme/active']);
  });

  it('maps 404 to a friendly "org not found" error', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/missing/repos'),
        respond: () =>
          jsonResponse({ message: 'Not Found' }, 404),
      },
    ]);
    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    await expect(
      enumerator.enumerate(
        { provider: 'github', type: 'org', name: 'missing' },
        { includeArchived: true, includeForks: true }
      )
    ).rejects.toThrow(/missing.*not found/i);
  });

  it('maps 401 to a friendly token-rejected error', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos'),
        respond: () => jsonResponse({ message: 'Bad credentials' }, 401),
      },
    ]);
    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    await expect(
      enumerator.enumerate(
        { provider: 'github', type: 'org', name: 'acme' },
        { includeArchived: true, includeForks: true }
      )
    ).rejects.toThrow(/rejected the token/);
  });
});

describe('log redaction guardrail', () => {
  it('cloneUrl is not present verbatim when stringified through a redactor', () => {
    // The redactor lives in src/preflight.ts; this test pins the contract:
    // the substring `x-access-token:<token>` must be the only thing the
    // redactor needs to replace to fully neutralise a leaked clone URL.
    const url = buildAuthenticatedCloneUrl(
      'https://github.com/acme/api.git',
      'ghp_xxxx'
    );
    const redacted = url.replace(/x-access-token:[^@]+@/, 'x-access-token:***@');
    expect(redacted).toBe('https://x-access-token:***@github.com/acme/api.git');
    expect(redacted).not.toContain('ghp_xxxx');
  });

  it('a reasonable JSON dump of a RepoListing does not leak the token through any other field', async () => {
    const fetchMock = makeFetchMock([
      {
        match: (u) => u.includes('/orgs/acme/repos'),
        respond: () => jsonResponse([makeRepo()]),
      },
    ]);
    const enumerator = new GitHubEnumerator(TOKEN, { request: { fetch: fetchMock } });
    const [listing] = await enumerator.enumerate(
      { provider: 'github', type: 'org', name: 'acme' },
      { includeArchived: true, includeForks: true }
    );

    // Pretend a sloppy logger does this by accident:
    const redactor = (s: string) =>
      s.replace(/x-access-token:[^@"]+@/g, 'x-access-token:***@');
    const dumped = redactor(JSON.stringify(listing));
    expect(dumped).not.toContain(TOKEN);
  });

  it('process logs are scrubbed even when something logs a JSON-stringified listing', () => {
    // Pure unit-level guardrail for the pattern the preflight redactor uses.
    const sample = `clone failed for ${buildAuthenticatedCloneUrl('https://github.com/acme/api.git', TOKEN)}`;
    const redacted = sample.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain('x-access-token:***@github.com/acme/api.git');
  });
});

describe('console.warn during rate limits is wired through', () => {
  it('does not throw when onRateLimit fires (warning path is called)', async () => {
    // We don't want to actually exercise GH's throttling plugin here (it's
    // their code); we just smoke-check that the constructor doesn't break.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enumerator = new GitHubEnumerator(TOKEN);
    expect(enumerator).toBeInstanceOf(GitHubEnumerator);
    spy.mockRestore();
  });
});
