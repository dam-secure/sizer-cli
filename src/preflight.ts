/**
 * Preflight: ensure the runtime is healthy and a PAT is available before any
 * subcommand starts work. Also installs a stdout/stderr redactor so any
 * accidentally-logged authenticated clone URL is scrubbed.
 *
 * Why "preflight" exists as its own module:
 *   - Each subcommand needs the same checks; centralising them keeps `cli.ts`
 *     honest.
 *   - The redactor MUST be installed before any other module gets a chance
 *     to log — including dependency code we don't control. Doing this in a
 *     dedicated entry call from `cli.ts` makes the ordering obvious.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ENV_TOKEN = 'DAMSECURE_SIZER_GITHUB_TOKEN';
const MIN_GIT = { major: 2, minor: 22 };

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  /** Resolved GitHub PAT. Already passed through the redactor's allowlist. */
  token: string;
  /** Detected git version (for diagnostics). */
  gitVersion: string;
}

export interface PreflightOptions {
  /** PAT supplied via `--token` flag (highest precedence). */
  tokenFlag?: string;
  /** Test override — replaces process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test override — invoked instead of `git --version`. */
  detectGit?: () => Promise<string>;
}

/**
 * Resolve a token, verify git is present at the right version, and install
 * a process-wide log redactor. Idempotent for the redactor; safe to call
 * once at the start of each subcommand.
 */
export async function preflight(
  options: PreflightOptions = {}
): Promise<PreflightResult> {
  const env = options.env ?? process.env;

  const token = resolveToken(options.tokenFlag, env);
  installLogRedactor();

  const gitVersion = await detectGit(options.detectGit);
  ensureGitVersion(gitVersion);

  return { token, gitVersion };
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
      `  3. Permissions ▸ Repository ▸ Contents: Read-only\n` +
      `  4. Permissions ▸ Repository ▸ Metadata: Read-only (auto-included)\n` +
      `  5. Generate, copy, and re-run with --token <pat> or export ${ENV_TOKEN}=<pat>.`
  );
}

async function detectGit(
  override: PreflightOptions['detectGit']
): Promise<string> {
  if (override) return override();
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return stdout.trim();
  } catch (err) {
    throw new PreflightError(
      `Could not run "git --version" — is git on your PATH?\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function ensureGitVersion(versionLine: string): void {
  // Examples we accept:
  //   "git version 2.40.1"
  //   "git version 2.40.1.windows.1"
  //   "git version 2.45.0 (Apple Git-145)"
  const match = versionLine.match(/git version (\d+)\.(\d+)/);
  if (!match) {
    throw new PreflightError(
      `Unrecognised git version output: "${versionLine}". Need git ${MIN_GIT.major}.${MIN_GIT.minor}+.`
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (
    major < MIN_GIT.major ||
    (major === MIN_GIT.major && minor < MIN_GIT.minor)
  ) {
    throw new PreflightError(
      `Detected ${versionLine.trim()}, but the sizer requires git ${MIN_GIT.major}.${MIN_GIT.minor}+ for partial clone (--filter=blob:none) support. Please upgrade.`
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
