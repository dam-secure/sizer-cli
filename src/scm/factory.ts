/**
 * Scope-string parser + enumerator factory.
 *
 * Scope syntax (CLI: --scope <spec>):
 *   "org=acme"             → GitHub org "acme"
 *   "github:org=acme"      → same (explicit provider)
 *   "user"                 → repos visible to the PAT-bearing user
 *   "github:user"          → same
 *   "github:user=octocat"  → reserved for v2 (currently treated as 'user')
 *   "gitlab:group=foo"     → v2; throws today
 *   "bitbucket:workspace=foo" → v2; throws today
 *   "azure:org=foo[/project=bar]" → v2; throws today
 */

import { GitHubEnumerator } from './github.js';
import { GitLabEnumerator } from './gitlab.js';
import { BitbucketEnumerator } from './bitbucket.js';
import { AzureDevOpsEnumerator } from './azure.js';
import type { ScmEnumerator, ScmScope } from './types.js';

export class ScopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeParseError';
  }
}

export function parseScope(raw: string): ScmScope {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ScopeParseError('--scope is required (e.g., "org=acme" or "user")');
  }

  const trimmed = raw.trim();

  // Split optional provider prefix.
  // "github:org=acme" → provider="github", body="org=acme"
  // "org=acme"        → provider="github" (default), body="org=acme"
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
  if (body === 'user') {
    return { provider: 'github', type: 'user' };
  }
  const userMatch = body.match(/^user=(.+)$/);
  if (userMatch) {
    return { provider: 'github', type: 'user', name: userMatch[1] };
  }
  const orgMatch = body.match(/^org=(.+)$/);
  if (orgMatch) {
    return { provider: 'github', type: 'org', name: orgMatch[1] };
  }
  throw new ScopeParseError(
    `GitHub scope must be "org=<name>" or "user" (got "${body}").`
  );
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
