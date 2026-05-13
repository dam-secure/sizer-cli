/**
 * GitLab enumerator — v2 placeholder.
 *
 * Intentionally throws to make the contract part of the codebase: when GitLab
 * lands, the implementation slots in here without changing the call sites in
 * `factory.ts` or anywhere downstream. Until then, `parseScope` will reject
 * any `gitlab:` scope and never reach this constructor in normal flow.
 */

import type {
  EnumerateOptions,
  RepoListing,
  ScmEnumerator,
  ScmScope,
} from './types.js';

export class GitLabEnumerator implements ScmEnumerator {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enumerate(_scope: ScmScope, _opts: EnumerateOptions): Promise<RepoListing[]> {
    throw new Error(
      'GitLab support is planned for v2; not implemented yet. Please open an issue or use --scope github=... in the meantime.'
    );
  }
}
