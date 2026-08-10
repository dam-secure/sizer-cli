/** Resolve auth and install the process-wide token redactor before work starts. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ENV_TOKEN = 'GHPAT';

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  token: string;
}

export interface PreflightOptions {
  /** PAT supplied via `--token` flag (highest precedence). */
  tokenFlag?: string;
  /** Test override — replaces process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test override — invoked instead of `git --version`. */
  checkGit?: () => Promise<void>;
}

export async function preflight(
  options: PreflightOptions = {}
): Promise<PreflightResult> {
  const env = options.env ?? process.env;

  const token = resolveToken(options.tokenFlag, env);
  installLogRedactor();
  await ensureGitAvailable(options.checkGit);

  return { token };
}

export function resolveToken(
  tokenFlag: string | undefined,
  env: NodeJS.ProcessEnv
): string {
  if (tokenFlag && tokenFlag.length > 0) return tokenFlag;
  const fromEnv = env[ENV_TOKEN];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new PreflightError(
    `Missing GitHub PAT. Pass --token <pat> or set ${ENV_TOKEN}.\n` +
      `\n` +
      `To create a fine-grained PAT:\n` +
      `  1. https://github.com/settings/personal-access-tokens/new\n` +
      `  2. Repository access: All repositories (or select the target org's repos)\n` +
      `  3. Permissions ▸ Repository ▸ Metadata: Read-only (auto-included)\n` +
      `  4. Permissions ▸ Repository ▸ Contents: Read-only\n` +
      `  5. Permissions ▸ Repository ▸ Pull requests: Read-only\n` +
      `  6. Generate, copy, and re-run with --token <pat> or export ${ENV_TOKEN}=<pat>.`
  );
}

async function ensureGitAvailable(
  override: PreflightOptions['checkGit']
): Promise<void> {
  if (override) return override();
  try {
    await execFileAsync('git', ['--version']);
  } catch (err) {
    throw new PreflightError(
      `Could not run "git --version". The Docker image should include git.\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Log redactor
// ---------------------------------------------------------------------------

let redactorInstalled = false;

/**
 * Pattern that matches the credential portion of an HTTPS clone URL we
 * inject — i.e., `x-access-token:<token>@`. Replacing this with
 * `x-access-token:***@` neutralises any leak.
 *
 * Exported so the SCM tests can pin the format the redactor relies on.
 */
export const REDACT_PATTERN = /x-access-token:[^@\s'"`]+@/g;

export function redactString(input: string): string {
  return input.replace(REDACT_PATTERN, 'x-access-token:***@');
}

/**
 * Wrap `process.stdout.write` and `process.stderr.write` so any string passing
 * through is scrubbed. Idempotent: subsequent calls are no-ops. Tests can
 * call `__resetRedactor()` to undo the wrapping.
 */
export function installLogRedactor(): void {
  if (redactorInstalled) return;
  redactorInstalled = true;

  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as typeof stream.write;
    // We cast through `unknown` because the union type of write's overloads
    // is awkward to express here; runtime semantics are unchanged.
    (stream.write as unknown as (chunk: unknown, ...args: unknown[]) => boolean) = (
      chunk: unknown,
      ...args: unknown[]
    ): boolean => {
      let scrubbed: unknown = chunk;
      if (typeof chunk === 'string') {
        scrubbed = redactString(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        const asStr = chunk.toString('utf8');
        const replaced = redactString(asStr);
        scrubbed = replaced === asStr ? chunk : Buffer.from(replaced, 'utf8');
      }
      return (original as (...a: unknown[]) => boolean)(scrubbed, ...args);
    };
  }
}

/** Test-only: undo the redactor wrapping. Not exported from index. */
export function __resetRedactor(): void {
  redactorInstalled = false;
}
