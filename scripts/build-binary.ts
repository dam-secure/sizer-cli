/**
 * Bun-compiled static-binary build script.
 *
 * Produces 4 self-contained executables under `dist/binary/`:
 *   damsecure-sizer-{linux,darwin}-{x64,arm64}
 *
 * `bun build src/cli.ts --compile` bundles the entire dependency graph plus
 * a Bun runtime into a single executable that runs without Node or Bun
 * installed on the target machine. The only external requirement is
 * `git` 2.22+ on PATH (decision D1; documented in README + checked at
 * preflight).
 *
 * Usage:
 *   npm run build:binary           # build all 4 targets
 *   npm run build:binary -- linux  # build linux-x64 + linux-arm64
 *   npm run build:binary -- darwin-arm64
 *
 * If `bun` isn't on PATH, prints a friendly message and exits non-zero so
 * CI fails loudly. Local devs see the same message and know to install Bun
 * (https://bun.sh/) before running.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, '..');

const ALL_TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
] as const;
type BunTarget = (typeof ALL_TARGETS)[number];

function targetMatchesFilter(target: BunTarget, filter: string): boolean {
  // Accept "linux", "darwin", "linux-arm64", "bun-linux-arm64", "all".
  if (filter === 'all') return true;
  const stripped = target.replace(/^bun-/, '');
  return stripped === filter || stripped.startsWith(`${filter}-`) || stripped === filter.replace(/^bun-/, '');
}

async function ensureBun(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('bun', ['--version']);
    return stdout.trim();
  } catch {
    process.stderr.write(
      'build-binary: `bun` is not on PATH. Install Bun first: https://bun.sh/\n' +
        '             (End users download prebuilt binaries from GitHub Releases.)\n'
    );
    process.exit(1);
  }
}

async function runEmbedIgnorefile(): Promise<void> {
  // Run via node — keeps the dependency on bun limited to the actual compile step.
  await execFileAsync('node', ['scripts/embed-ignorefile.mjs'], {
    cwd: PACKAGE_ROOT,
  });
}

async function maybeAdHocSignDarwinBinary(target: BunTarget, outfile: string): Promise<void> {
  if (process.platform !== 'darwin' || !target.startsWith('bun-darwin-')) {
    return;
  }

  try {
    await execFileAsync('codesign', ['--force', '--sign', '-', outfile]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`build-binary: warning: failed to ad-hoc sign ${outfile}: ${message}\n`);
  }
}

async function buildOne(target: BunTarget): Promise<void> {
  const stripped = target.replace(/^bun-/, '');
  const outfile = resolve(PACKAGE_ROOT, 'dist', 'binary', `damsecure-sizer-${stripped}`);
  const outdir = dirname(outfile);
  if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

  process.stdout.write(`build-binary: building ${target} → ${outfile}\n`);
  await execFileAsync(
    'bun',
    [
      'build',
      'src/cli.ts',
      '--compile',
      `--target=${target}`,
      `--outfile=${outfile}`,
    ],
    {
      cwd: PACKAGE_ROOT,
      // Bun 1.3.12 can emit macOS binaries with a corrupt LC_CODE_SIGNATURE,
      // which are killed before startup and cannot be re-signed. Disable Bun's
      // Mach-O signing and apply our own ad-hoc signature below.
      env: { ...process.env, BUN_NO_CODESIGN_MACHO_BINARY: '1' },
    }
  );

  await maybeAdHocSignDarwinBinary(target, outfile);

  const size = statSync(outfile).size;
  process.stdout.write(
    `build-binary: ${target} done (${(size / 1024 / 1024).toFixed(1)} MB)\n`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filter = args[0] ?? 'all';

  const targets = ALL_TARGETS.filter((t) => targetMatchesFilter(t, filter));
  if (targets.length === 0) {
    process.stderr.write(
      `build-binary: no targets match "${filter}". Known: ${ALL_TARGETS.map((t) => t.replace(/^bun-/, '')).join(', ')}, or "all".\n`
    );
    process.exit(1);
  }

  const bunVersion = await ensureBun();
  process.stdout.write(`build-binary: using bun ${bunVersion}\n`);
  await runEmbedIgnorefile();

  for (const target of targets) {
    await buildOne(target);
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`build-binary: failed — ${message}\n`);
  process.exit(1);
});
