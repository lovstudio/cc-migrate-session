#!/usr/bin/env node
/**
 * cc-mv — move a project folder and migrate its Claude Code state.
 *
 * Three-in-one:
 *   1. mv <FROM> <TO>                  (fs.renameSync, EXDEV → shell `mv`)
 *   2. rewrite session store           (~/.claude/projects/<slug>/*.jsonl cwd)
 *   3. rewrite prompt history + running sessions
 *         (~/.claude/history.jsonl .project, ~/.claude/sessions/*.json .cwd)
 *
 * Subdirectory sessions are handled too: any slug under ~/.claude/projects/
 * that matches <fromSlug> OR begins with <fromSlug>-  corresponds to FROM
 * or a descendant path — all are migrated in one go.
 *
 * Also invoked as `cc-migrate-session` (alias): that entry point skips the
 * actual fs mv and only migrates CC state — backwards-compatible behavior.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Slug rule (reverse-engineered from ~/.claude/projects/)
// ---------------------------------------------------------------------------
// CC replaces every character that is NOT [A-Za-z0-9] with "-".
// This means "/" becomes "-", but so does ".", "@", and every CJK char.
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function normalizeInputPath(p: string): string {
  const abs = path.resolve(expandTilde(p));
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
}

// ---------------------------------------------------------------------------
// Affected-slug discovery
// ---------------------------------------------------------------------------
// A slug belongs to FROM (or a descendant path) iff:
//   slug === fromSlug                       → FROM itself
//   slug.startsWith(fromSlug + "-")         → a descendant (because any sub
//                                              path FROM/x slugifies to
//                                              fromSlug + "-" + pathToSlug(x))
// Returns one entry per such slug, with the reverse-derived "from path".
// We can't perfectly reverse a slug to a path in general (the slug is lossy),
// but we can read any jsonl inside the slug dir to recover the original cwd.
export interface AffectedSlug {
  slug: string;
  slugDir: string;
  sessionCount: number;
  sizeBytes: number;
  // The original absolute path this slug belongs to, read from the first
  // jsonl that has a cwd field. Null if the slug dir is empty / no cwd.
  originalPath: string | null;
}

export function findAffectedSlugs(projectsDir: string, fromSlug: string): AffectedSlug[] {
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const out: AffectedSlug[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const slug = ent.name;
    if (slug !== fromSlug && !slug.startsWith(fromSlug + "-")) continue;
    const slugDir = path.join(projectsDir, slug);
    const info = summarizeSlugDir(slugDir);
    out.push({ slug, slugDir, ...info });
  }
  return out;
}

function summarizeSlugDir(slugDir: string): { sessionCount: number; sizeBytes: number; originalPath: string | null } {
  let sessionCount = 0;
  let sizeBytes = 0;
  let originalPath: string | null = null;
  for (const name of fs.readdirSync(slugDir)) {
    const p = path.join(slugDir, name);
    const st = fs.statSync(p);
    if (st.isFile() && name.endsWith(".jsonl")) {
      sessionCount += 1;
      sizeBytes += st.size;
      if (!originalPath) originalPath = readFirstCwd(p);
    }
  }
  return { sessionCount, sizeBytes, originalPath };
}

function readFirstCwd(jsonlPath: string): string | null {
  const content = fs.readFileSync(jsonlPath, "utf8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.cwd === "string") return obj.cwd;
    } catch {
      // skip
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// jsonl rewrite (generic cwd-style prefix rewrite)
// ---------------------------------------------------------------------------
function rewriteJsonlField(content: string, field: string, fromPath: string, toPath: string): { out: string; rewrote: number } {
  const lines = content.split("\n");
  let rewrote = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line);
      const val = obj[field];
      if (typeof val === "string") {
        if (val === fromPath) {
          obj[field] = toPath;
          rewrote += 1;
          return JSON.stringify(obj);
        } else if (val.startsWith(fromPath + "/")) {
          obj[field] = toPath + val.slice(fromPath.length);
          rewrote += 1;
          return JSON.stringify(obj);
        }
      }
      return line;
    } catch {
      return line; // preserve malformed
    }
  });
  return { out: out.join("\n"), rewrote };
}

// ---------------------------------------------------------------------------
// Copy with mtime preservation (used when merging into existing dest slug dir)
// ---------------------------------------------------------------------------
function copyFilePreservingTimes(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  const st = fs.statSync(src);
  fs.utimesSync(dst, st.atime, st.mtime);
}

function copyDirPreservingTimes(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirPreservingTimes(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else {
      copyFilePreservingTimes(s, d);
    }
  }
  const st = fs.statSync(src);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Real fs mv — prefer rename (instant, preserves everything), fall back to
// shell `mv` for cross-device (EXDEV). Shell `mv` also preserves metadata
// better than a manual copy+unlink loop.
// ---------------------------------------------------------------------------
function moveDir(from: string, to: string): { method: "rename" | "shell-mv" } {
  try {
    fs.renameSync(from, to);
    return { method: "rename" };
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
  }
  const res = spawnSync("mv", [from, to], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`mv exited with status ${res.status}`);
  return { method: "shell-mv" };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Migration engine — operates on a list of (fromPath, toPath) pairs.
// All rewrites derive from this list: each affected slug dir gets renamed/
// merged, each jsonl line gets its cwd rewritten against the matching pair.
// ---------------------------------------------------------------------------
interface MigrationPair {
  from: string;      // original absolute path (e.g. /Users/mark/old/sub)
  to: string;        // new absolute path     (e.g. /Users/mark/new/sub)
  fromSlug: string;
  toSlug: string;
  fromDir: string;   // projectsDir + fromSlug
  toDir: string;     // projectsDir + toSlug
  sessionCount: number;
  sizeBytes: number;
}

interface MigrateResult {
  slugsMigrated: number;
  jsonlFilesWritten: number;
  cwdRewrites: number;
  historyRewrites: number;
  runningSessionRewrites: number;
  firstSessionId: string | null;
}

function migrateSlugs(pairs: MigrationPair[]): { jsonlFilesWritten: number; cwdRewrites: number; firstSessionId: string | null } {
  let jsonlFilesWritten = 0;
  let cwdRewrites = 0;
  let firstSessionId: string | null = null;

  for (const pair of pairs) {
    if (!fs.existsSync(pair.fromDir)) continue;
    fs.mkdirSync(pair.toDir, { recursive: true });
    for (const entry of fs.readdirSync(pair.fromDir, { withFileTypes: true })) {
      const src = path.join(pair.fromDir, entry.name);
      const dst = path.join(pair.toDir, entry.name);
      if (entry.isDirectory()) {
        copyDirPreservingTimes(src, dst);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".jsonl")) {
        const content = fs.readFileSync(src, "utf8");
        const { out, rewrote } = rewriteJsonlField(content, "cwd", pair.from, pair.to);
        fs.writeFileSync(dst, out);
        const st = fs.statSync(src);
        fs.utimesSync(dst, st.atime, st.mtime);
        cwdRewrites += rewrote;
        jsonlFilesWritten += 1;
        if (!firstSessionId) firstSessionId = extractSessionId(out);
      } else {
        copyFilePreservingTimes(src, dst);
      }
    }
  }
  return { jsonlFilesWritten, cwdRewrites, firstSessionId };
}

function extractSessionId(jsonlContent: string): string | null {
  for (const line of jsonlContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.sessionId === "string") return obj.sessionId;
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rewrite ~/.claude/history.jsonl (the prompt-history index: up-arrow recall)
// Field: "project" — absolute path. Rewrite any pair match.
// ---------------------------------------------------------------------------
function rewriteHistoryJsonl(historyPath: string, pairs: MigrationPair[]): number {
  if (!fs.existsSync(historyPath)) return 0;
  const content = fs.readFileSync(historyPath, "utf8");
  let total = 0;
  let current = content;
  // Apply each pair in order. Later pairs can act on earlier-rewritten text
  // without issue because the TO paths are (by construction) not prefixes of
  // any FROM path.
  for (const pair of pairs) {
    const { out, rewrote } = rewriteJsonlField(current, "project", pair.from, pair.to);
    current = out;
    total += rewrote;
  }
  if (total > 0) fs.writeFileSync(historyPath, current);
  return total;
}

// ---------------------------------------------------------------------------
// Rewrite ~/.claude/sessions/<pid>.json (per-pid running-session records)
// Field: "cwd" — absolute path. Most of these are stale (pid long gone).
// ---------------------------------------------------------------------------
function rewriteRunningSessions(sessionsDir: string, pairs: MigrationPair[]): number {
  if (!fs.existsSync(sessionsDir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!name.endsWith(".json")) continue;
    const p = path.join(sessionsDir, name);
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (typeof obj.cwd !== "string") continue;
    for (const pair of pairs) {
      if (obj.cwd === pair.from) { obj.cwd = pair.to; total += 1; break; }
      if (obj.cwd.startsWith(pair.from + "/")) { obj.cwd = pair.to + obj.cwd.slice(pair.from.length); total += 1; break; }
    }
    fs.writeFileSync(p, JSON.stringify(obj));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Build migration pairs from discovered slugs.
// Root pair is always (from, to). Sub-slugs use the ORIGINAL cwd recovered
// from their jsonl — that's the authoritative FROM path (the slug itself is
// lossy, so we can't reconstruct it).
// ---------------------------------------------------------------------------
function buildPairs(from: string, to: string, affected: AffectedSlug[], projectsDir: string): MigrationPair[] {
  const pairs: MigrationPair[] = [];
  const fromSlug = pathToSlug(from);
  const toSlug = pathToSlug(to);

  // Root pair (always present, even if the root slug dir is empty — we still
  // want to rewrite history.jsonl entries pointing at FROM exactly).
  pairs.push({
    from, to, fromSlug, toSlug,
    fromDir: path.join(projectsDir, fromSlug),
    toDir: path.join(projectsDir, toSlug),
    sessionCount: 0, sizeBytes: 0,
  });

  for (const a of affected) {
    if (a.slug === fromSlug) {
      // merge counts into root pair
      pairs[0].sessionCount = a.sessionCount;
      pairs[0].sizeBytes = a.sizeBytes;
      continue;
    }
    const orig = a.originalPath;
    if (!orig) continue;              // empty slug dir or no cwd — skip
    if (orig !== from && !orig.startsWith(from + "/")) continue; // sanity
    const subFrom = orig;
    const subTo = to + subFrom.slice(from.length);
    pairs.push({
      from: subFrom, to: subTo,
      fromSlug: a.slug,
      toSlug: pathToSlug(subTo),
      fromDir: a.slugDir,
      toDir: path.join(projectsDir, pathToSlug(subTo)),
      sessionCount: a.sessionCount,
      sizeBytes: a.sizeBytes,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
interface Args {
  from: string;
  to: string;
  yes: boolean;
  dryRun: boolean;
  projectsDir: string;
  json: boolean;
  doFsMv: boolean; // cc-mv does it; cc-migrate-session (alias) skips it
}

function parseArgs(argv: string[], defaultDoFsMv: boolean): Args | { help: true } | { error: string } {
  const positional: string[] = [];
  let yes = false;
  let dryRun = false;
  let projectsDir = path.join(os.homedir(), ".claude", "projects");
  let json = false;
  let doFsMv = defaultDoFsMv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--no-mv") doFsMv = false;
    else if (a === "--mv") doFsMv = true;
    else if (a === "--projects-dir") projectsDir = argv[++i];
    else if (a.startsWith("-")) return { error: `Unknown flag: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 2) return { error: "Expected exactly 2 positional args: <FROM> <TO>" };
  return {
    from: normalizeInputPath(positional[0]),
    to: normalizeInputPath(positional[1]),
    yes, dryRun, projectsDir, json, doFsMv,
  };
}

function printHelp(binName: string, defaultDoFsMv: boolean): void {
  if (defaultDoFsMv) {
    console.log(`${binName} — move a project folder and migrate all Claude Code state in one shot

Usage:
  ${binName} <FROM> <TO> [options]

What it does:
  1. mv FROM → TO                          (fs.renameSync, falls back to shell mv)
  2. Rewrites ~/.claude/projects/<slug>/    session store (including sub-dirs)
  3. Rewrites ~/.claude/history.jsonl       (prompt up-arrow history)
  4. Rewrites ~/.claude/sessions/*.json     (running-session records)

Options:
  -y, --yes              Execute without interactive confirmation
  --dry-run              Print the plan, do not write
  --no-mv                Skip the filesystem mv; only migrate CC state
  --projects-dir <dir>   CC projects dir (default: ~/.claude/projects)
  --json                 Machine-readable output (for skill integration)
  -h, --help             Show this help

Examples:
  ${binName} /Users/mark/old-project /Users/mark/new-project
  ${binName} ~/old ~/new --yes
  ${binName} /a /b --dry-run
`);
  } else {
    console.log(`${binName} — migrate Claude Code sessions (CC-state only; does NOT move files on disk)

Usage:
  ${binName} <FROM> <TO> [options]

This is the backwards-compatible entry point. For a full move + migration,
use  cc-mv  instead (same syntax, also moves the folder on disk).

Options:
  -y, --yes              Execute without interactive confirmation
  --dry-run              Print the plan, do not write
  --mv                   Also move FROM → TO on disk (equivalent to cc-mv)
  --projects-dir <dir>   CC projects dir (default: ~/.claude/projects)
  --json                 Machine-readable output
  -h, --help             Show this help
`);
  }
}

async function main(binName: string, defaultDoFsMv: boolean): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), defaultDoFsMv);
  if ("help" in parsed) { printHelp(binName, defaultDoFsMv); return; }
  if ("error" in parsed) { console.error(`error: ${parsed.error}\n`); printHelp(binName, defaultDoFsMv); process.exit(2); }

  const { from, to, yes, dryRun, projectsDir, json, doFsMv } = parsed;
  const fromSlug = pathToSlug(from);
  const toSlug = pathToSlug(to);
  const historyPath = path.join(path.dirname(projectsDir), "history.jsonl");
  const sessionsDir = path.join(path.dirname(projectsDir), "sessions");

  const affected = findAffectedSlugs(projectsDir, fromSlug);
  const pairs = buildPairs(from, to, affected, projectsDir);
  const fromDirExistsOnDisk = fs.existsSync(from);
  const toDirExistsOnDisk = fs.existsSync(to);

  const planJson = {
    from, to, fromSlug, toSlug,
    doFsMv,
    fromDirExistsOnDisk,
    toDirExistsOnDisk,
    pairs: pairs.map(p => ({
      from: p.from, to: p.to, fromSlug: p.fromSlug, toSlug: p.toSlug,
      sessionCount: p.sessionCount, sizeBytes: p.sizeBytes,
      toSlugDirExists: fs.existsSync(p.toDir),
    })),
    totalSessions: pairs.reduce((a, p) => a + p.sessionCount, 0),
    totalSize: pairs.reduce((a, p) => a + p.sizeBytes, 0),
  };

  if (json && (dryRun || planJson.totalSessions === 0)) {
    console.log(JSON.stringify({ phase: "plan", ...planJson }, null, 2));
    if (dryRun) return;
  }

  if (!json) {
    console.log(`From : ${from}`);
    console.log(`       slug: ${fromSlug}`);
    console.log(`To   : ${to}`);
    console.log(`       slug: ${toSlug}`);
    console.log("");
    if (doFsMv) {
      if (!fromDirExistsOnDisk) {
        console.log(`⚠ FROM does not exist on disk: ${from}`);
        console.log(`  (--no-mv is implied — only CC state will be migrated)`);
      }
      if (toDirExistsOnDisk && fromDirExistsOnDisk) {
        console.log(`✗ TO already exists on disk: ${to}`);
        console.log(`  Refusing to overwrite. Move or remove it first.`);
        process.exit(3);
      }
    }
    if (planJson.totalSessions === 0) {
      console.log(`No CC sessions found for this path or any descendant.`);
      console.log(`(slug dir scanned: ${projectsDir})`);
      if (!doFsMv || !fromDirExistsOnDisk) return;
      console.log(`Proceeding with fs mv only.`);
    } else {
      console.log(`Affected slug dirs: ${pairs.filter(p => p.sessionCount > 0).length}`);
      for (const p of pairs) {
        if (p.sessionCount === 0) continue;
        const marker = p.from === from ? "·" : "↳";
        console.log(`  ${marker} ${p.from}`);
        console.log(`       → ${p.to}`);
        console.log(`       ${p.sessionCount} session(s), ${formatBytes(p.sizeBytes)}${fs.existsSync(p.toDir) ? "  (dest slug exists — will merge)" : ""}`);
      }
    }
    console.log("");
  }

  if (dryRun) {
    if (!json) console.log("--dry-run: no changes written.");
    return;
  }

  if (!yes) {
    const hasSubDirs = pairs.filter(p => p.sessionCount > 0 && p.from !== from).length;
    let q = `Proceed? [Y/n] `;
    if (hasSubDirs > 0) {
      q = `Found ${hasSubDirs} sub-dir(s) with CC sessions. Migrate everything? [Y/n] `;
    }
    const ans = (await prompt(q)).trim();
    if (ans && !/^y(es)?$/i.test(ans)) { console.log("Aborted."); return; }
  }

  // Phase 1 — fs mv (unless disabled or FROM missing)
  let fsMvMethod: string | null = null;
  if (doFsMv && fromDirExistsOnDisk) {
    if (toDirExistsOnDisk) {
      throw new Error(`TO already exists on disk: ${to}`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const { method } = moveDir(from, to);
    fsMvMethod = method;
    if (!json) console.log(`✓ mv ${from} → ${to}  (${method})`);
  }

  // Phase 2 — slug store migration (copy-then-rewrite; old slug dir untouched)
  const slugRes = migrateSlugs(pairs);

  // Phase 3 — history.jsonl
  const historyRewrites = rewriteHistoryJsonl(historyPath, pairs);

  // Phase 4 — running-session records
  const runningSessionRewrites = rewriteRunningSessions(sessionsDir, pairs);

  const result: MigrateResult = {
    slugsMigrated: pairs.filter(p => p.sessionCount > 0).length,
    jsonlFilesWritten: slugRes.jsonlFilesWritten,
    cwdRewrites: slugRes.cwdRewrites,
    historyRewrites,
    runningSessionRewrites,
    firstSessionId: slugRes.firstSessionId,
  };

  if (json) {
    console.log(JSON.stringify({
      phase: "done",
      ...planJson,
      fsMvMethod,
      result,
      restartHint: {
        cd: to,
        command: result.firstSessionId ? `claude --resume ${result.firstSessionId}` : `claude --resume`,
      },
    }, null, 2));
    return;
  }

  console.log("");
  console.log(`✓ Migrated ${result.slugsMigrated} slug dir(s), ${result.jsonlFilesWritten} jsonl file(s)`);
  console.log(`✓ Rewrote ${result.cwdRewrites} cwd line(s) in sessions`);
  if (historyRewrites > 0) console.log(`✓ Rewrote ${historyRewrites} entry/entries in history.jsonl`);
  if (runningSessionRewrites > 0) console.log(`✓ Rewrote ${runningSessionRewrites} running-session record(s)`);
  console.log("");
  console.log(`Old slug dirs are still intact at ${projectsDir}/${fromSlug}* — delete them after verifying --resume works.`);
  console.log("");
  console.log("Next step — restart Claude Code in the new location:");
  console.log(`  cd ${to}`);
  console.log(`  claude --resume${result.firstSessionId ? `   # or: claude --resume ${result.firstSessionId}` : ""}`);
}

// ---------------------------------------------------------------------------
// Entry detection — one bundle, two bins. Default behavior depends on which
// symlink / bin name invoked us.
// ---------------------------------------------------------------------------
const invoked = path.basename(process.argv[1] || "cc-mv");
const defaultDoFsMv = !/cc-migrate-session/.test(invoked);
const binName = defaultDoFsMv ? "cc-mv" : "cc-migrate-session";

main(binName, defaultDoFsMv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
