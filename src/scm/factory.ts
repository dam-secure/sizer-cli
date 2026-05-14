/**
 * Scope-string parser + enumerator factory.
 *
 * Scope syntax (CLI: --scope <spec>):
 *   omitted / "all"        → all repos visible to the PAT-bearing user
 *   "acme"                 → repos whose full name starts with "acme/"
 *   "github:acme"          → same, explicit provider
 *   "gitlab:group=foo"     → v2; throws today
 *   "bitbucket:workspace=foo" → v2; throws today
 *   "azure:org=foo[/project=bar]" → v2; throws today
 */

import { GitHubEnumerator } from './github.js';
import { GitLabEnumerator } from './gitlab.js';
import { BitbucketEnumerator } from './bitbucket.js';
import { AzureDevOpsEnumerator } from './azure.js';
import type { ScmEnumerator, ScmScope } from './types.js';

export const DEFAULT_SCOPE_SPEC = 'all';

export const DEFAULT_SCOPE_NOTICE =
  '[sizer] no --scope supplied; using all repositories visible to the GitHub token. Use --scope <owner> to restrict enumeration.\n';

export class ScopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeParseError';
  }
}

export interface ResolvedScope {
  scope: ScmScope;
  usedDefault: boolean;
}

export function resolveScope(raw?: string): ResolvedScope {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { scope: parseScope(DEFAULT_SCOPE_SPEC), usedDefault: true };
  }

  return { scope: parseScope(raw), usedDefault: false };
}

export function parseScope(raw: string): ScmScope {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ScopeParseError('--scope must be a GitHub owner, e.g. "acme".');
  }

  const trimmed = raw.trim();

  // Split optional provider prefix.
  // "github:acme" → provider="github", body="acme"
  // "acme"        → provider="github" (default), body="acme"
  let provider: string;
  let body: string;
  const providerMatch = trimmed.match(/^([a-z]+):(.+)$/i);
  if (providerMatch) {
    provider = providerMatch[1].toLowerCase();
    body = providerMatch[2];
  } else {
    provider = 'github';
    body = trimmed;
  }

  switch (provider) {
    case 'github':
      return parseGitHubBody(body);
    case 'gitlab': {
      const m = body.match(/^group=(.+)$/);
      if (!m) {
        throw new ScopeParseError(
          'GitLab scope must be of the form "gitlab:group=<name>" (v2 — not yet implemented).'
        );
      }
      return { provider: 'gitlab', group: m[1] };
    }
    case 'bitbucket': {
      const m = body.match(/^workspace=(.+)$/);
      if (!m) {
        throw new ScopeParseError(
          'Bitbucket scope must be of the form "bitbucket:workspace=<name>" (v2 — not yet implemented).'
        );
      }
      return { provider: 'bitbucket', workspace: m[1] };
    }
    case 'azure': {
      const m = body.match(/^org=([^/]+)(?:\/project=(.+))?$/);
      if (!m) {
        throw new ScopeParseError(
          'Azure DevOps scope must be of the form "azure:org=<organisation>[/project=<project>]" (v2 — not yet implemented).'
        );
      }
      return {
        provider: 'azure',
        organization: m[1],
        ...(m[2] ? { project: m[2] } : {}),
      };
    }
    default:
      throw new ScopeParseError(
        `Unknown scope provider "${provider}". Supported v1: github (default). Planned v2: gitlab, bitbucket, azure.`
      );
  }
}

function parseGitHubBody(body: string): ScmScope {
  if (body === 'all' || body === 'user') {
    return { provider: 'github', type: 'all' };
  }
  const userMatch = body.match(/^user=(.+)$/);
  if (userMatch) {
    return parseGitHubOwner(userMatch[1]);
  }
  const orgMatch = body.match(/^org=(.+)$/);
  if (orgMatch) {
    return parseGitHubOwner(orgMatch[1]);
  }
  return parseGitHubOwner(body);
}

function parseGitHubOwner(owner: string): ScmScope {
  const trimmed = owner.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(trimmed)) {
    throw new ScopeParseError(
      `GitHub scope must be an owner/login such as "acme" (got "${owner}").`
    );
  }
  return { provider: 'github', type: 'owner', owner: trimmed };
}

export interface CreateEnumeratorOptions {
  /** Forwarded to GitHubEnumerator (test override). */
  baseUrl?: string;
  /** Forwarded to GitHubEnumerator (test override). */
  request?: { fetch: typeof fetch };
}

export function createEnumerator(
  scope: ScmScope,
  token: string,
  options: CreateEnumeratorOptions = {}
): ScmEnumerator {
  switch (scope.provider) {
    case 'github':
      return new GitHubEnumerator(token, options);
    case 'gitlab':
      return new GitLabEnumerator();
    case 'bitbucket':
      return new BitbucketEnumerator();
    case 'azure':
      return new AzureDevOpsEnumerator();
  }
}
