import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";

type BuildOptions = {
  entry: string;
  outdir: string;
  target?: string;
  targets?: string[];
  minify: boolean;
  sourcemap: boolean;
  macosUniversal: boolean;
};

const BINARY_NAME = "maid";

function usageAndExit(code: number): never {
  const msg = `
Build standalone CLI binaries via Bun.

Usage:
  bun scripts/cli/build.ts [options]

Options:
  --entry <path>             Entry file (default: maid.ts)
  --outdir <path>            Output directory (default: dist/cli)
  --target <bun-target>      Single target (ex: bun-darwin-arm64)
  --targets <t1,t2,...>      Multiple targets (comma-separated)
  --macos-universal          Build darwin arm64+x64 and lipo into one binary (macOS only)
  --no-minify                Disable minification
  --sourcemap                Emit sourcemaps (defaults off)

Examples:
  bun scripts/cli/build.ts
  bun scripts/cli/build.ts --target bun-linux-x64
  bun scripts/cli/build.ts --targets bun-darwin-arm64,bun-darwin-x64
  bun scripts/cli/build.ts --macos-universal
`.trim();

  console.log(msg);
  process.exit(code);
}

function parseArgs(argv: string[]): BuildOptions {
  const opts: BuildOptions = {
    entry: "maid.ts",
    outdir: "dist",
    minify: true,
    sourcemap: false,
    macosUniversal: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        usageAndExit(0);
        break;
      case "--entry":
        opts.entry = argv[++i] ?? "";
        break;
      case "--outdir":
        opts.outdir = argv[++i] ?? "";
        break;
      case "--target":
        opts.target = argv[++i];
        break;
      case "--targets": {
        const raw = argv[++i] ?? "";
        opts.targets = raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      }
      case "--macos-universal":
        opts.macosUniversal = true;
        break;
      case "--no-minify":
        opts.minify = false;
        break;
      case "--sourcemap":
        opts.sourcemap = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          usageAndExit(1);
        }
        break;
    }
  }

  if (!opts.entry || !opts.outdir) usageAndExit(1);
  if (opts.target && opts.targets?.length) {
    console.error("Use either --target or --targets (not both).");
    usageAndExit(1);
  }
  return opts;
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const hasPackageJson = existsSync(path.join(dir, "package.json"));
    const hasBunLock = existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, "bun.lockb"));
    if (hasPackageJson && hasBunLock) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find repo root (expected package.json + bun.lock).");
}

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function sanitizeTargetForFilename(target: string) {
  return target.replaceAll("/", "-").replaceAll(":", "-");
}

function run(cmd: string[], cwd: string) {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}

function getVersionFromPackageJson(root: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function buildOne({
  root,
  entryAbs,
  outdirAbs,
  target,
  minify,
  sourcemap,
}: {
  root: string;
  entryAbs: string;
  outdirAbs: string;
  target?: string;
  minify: boolean;
  sourcemap: boolean;
}): string {
  const filename = target ? `${BINARY_NAME}-${sanitizeTargetForFilename(target)}` : BINARY_NAME;
  const outfileAbs = path.join(outdirAbs, filename);

  const args = [
    "bun",
    "build",
    entryAbs,
    "--compile",
    "--outfile",
    outfileAbs,
    ...(target ? ["--target", target] : []),
    ...(minify ? ["--minify"] : []),
    ...(sourcemap ? ["--sourcemap"] : []),
  ];

  console.log(`\n→ Building ${path.relative(root, outfileAbs)}${target ? ` (${target})` : ""}`);
  run(args, root);
  return outfileAbs;
}

function buildMacosUniversal({
  root,
  entryAbs,
  outdirAbs,
  minify,
  sourcemap,
}: {
  root: string;
  entryAbs: string;
  outdirAbs: string;
  minify: boolean;
  sourcemap: boolean;
}) {
  if (process.platform !== "darwin") {
    console.error("--macos-universal is only supported on macOS.");
    process.exit(1);
  }

  const arm = buildOne({
    root,
    entryAbs,
    outdirAbs,
    target: "bun-darwin-arm64",
    minify,
    sourcemap,
  });
  const x64 = buildOne({
    root,
    entryAbs,
    outdirAbs,
    target: "bun-darwin-x64",
    minify,
    sourcemap,
  });

  const universal = path.join(outdirAbs, BINARY_NAME);
  console.log(`\n→ Creating universal binary ${path.relative(root, universal)}`);
  run(["lipo", "-create", arm, x64, "-output", universal], root);
}

const opts = parseArgs(process.argv.slice(2));
const root = findRepoRoot(import.meta.dir);
const localProjectRoot = path.resolve(import.meta.dir, "../..");
let resolveRoot = root;
let entryAbs = path.resolve(resolveRoot, opts.entry);
let outdirAbs = path.resolve(resolveRoot, opts.outdir);

// Support running from a split-out CLI project even when this folder still lives
// inside a larger repo with package.json + bun.lock at a higher level.
if (!existsSync(entryAbs)) {
  const localEntryAbs = path.resolve(localProjectRoot, opts.entry);
  if (existsSync(localEntryAbs)) {
    resolveRoot = localProjectRoot;
    entryAbs = localEntryAbs;
    outdirAbs = path.resolve(resolveRoot, opts.outdir);
  }
}

if (!existsSync(entryAbs)) {
  console.error(`Entry not found: ${opts.entry}`);
  process.exit(1);
}

ensureDir(outdirAbs);

const version = getVersionFromPackageJson(resolveRoot);
if (version) console.log(`maid version: ${version}`);

if (opts.macosUniversal) {
  buildMacosUniversal({ root: resolveRoot, entryAbs, outdirAbs, minify: opts.minify, sourcemap: opts.sourcemap });
  process.exit(0);
}

const targets = opts.targets?.length ? opts.targets : opts.target ? [opts.target] : [undefined];
for (const target of targets) {
  buildOne({ root: resolveRoot, entryAbs, outdirAbs, target, minify: opts.minify, sourcemap: opts.sourcemap });
}
