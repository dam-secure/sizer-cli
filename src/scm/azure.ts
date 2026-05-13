/**
 * Azure DevOps enumerator — v2 placeholder. See gitlab.ts for the rationale.
 */

import type {
  EnumerateOptions,
  RepoListing,
  ScmEnumerator,
  ScmScope,
} from './types.js';

export class AzureDevOpsEnumerator implements ScmEnumerator {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async enumerate(_scope: ScmScope, _opts: EnumerateOptions): Promise<RepoListing[]> {
    throw new Error(
      'Azure DevOps support is planned for v2; not implemented yet. Use --scope github=... in the meantime.'
    );
  }
}
