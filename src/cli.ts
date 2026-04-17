#!/usr/bin/env node
/**
 * cc-migrate-session
 *
 * Migrate Claude Code sessions when a project folder moves.
 *
 * Usage:
 *   npx @lovstudio/cc-migrate-session <FROM> <TO> [--yes] [--dry-run] [--projects-dir <dir>]
 *
 * What it does:
 *   1. Computes the slug for FROM and TO (CC rule: every non-alnum char → "-")
 *   2. Scans ~/.claude/projects/<from-slug>/ for session jsonl files
 *   3. Prints a preview (file count, size, session ids)
 *   4. On --yes (or interactive y): copies dir to <to-slug>, rewrites `cwd` fields
 *      in every jsonl line from FROM → TO
 *   5. Prints the restart hint: `cd <TO> && claude --resume`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Slug rule (reverse-engineered from ~/.claude/projects/)
// ---------------------------------------------------------------------------
// CC replaces every character that is NOT [A-Za-z0-9] with "-".
// This means "/" becomes "-", but so does ".", "@", and every CJK char.
// Example: /Users/mark/.claude         → -Users-mark--claude     (. → -)
//          /Users/mark/@手工川          → -Users-mark-----        (@ plus 3 CJK)
//          /Users/mark/my-project       → -Users-mark-my-project  (existing "-" preserved)
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, "-");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function normalizeInputPath(p: string): string {
  // 1. expand ~
  // 2. resolve to absolute (from cwd) — but DO NOT require existence,
  //    since FROM may no longer exist (that's the whole point)
  // 3. strip trailing slash except for root
  const abs = path.resolve(expandTilde(p));
  return abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
}

interface SessionInfo {
  file: string;
  sessionId: string | null;
  lineCount: number;
  sizeBytes: number;
  sampleCwd: string | null;
}

function scanSlugDir(slugDir: string): SessionInfo[] {
  if (!fs.existsSync(slugDir)) return [];
  const files = fs
    .readdirSync(slugDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(slugDir, f));

  return files.map((file) => {
    const stat = fs.statSync(file);
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let sessionId: string | null = null;
    let sampleCwd: string | null = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!sessionId && typeof obj.sessionId === "string") sessionId = obj.sessionId;
        if (!sampleCwd && typeof obj.cwd === "string") sampleCwd = obj.cwd;
        if (sessionId && sampleCwd) break;
      } catch {
        // skip malformed line
      }
    }
    return {
      file,
      sessionId,
      lineCount: lines.length,
      sizeBytes: stat.size,
      sampleCwd,
    };
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

// Rewrite cwd in every jsonl line:
// - EXACT match (obj.cwd === FROM) → rewrite to TO
// - PREFIX match (obj.cwd starts with FROM + "/") → rewrite prefix
// The prefix case matters if CC ever logged a sub-directory cwd inside the project.
function rewriteJsonl(content: string, fromPath: string, toPath: string): { out: string; rewrote: number } {
  const lines = content.split("\n");
  let rewrote = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const obj = JSON.parse(line);
      let changed = false;
      if (typeof obj.cwd === "string") {
        if (obj.cwd === fromPath) {
          obj.cwd = toPath;
          changed = true;
        } else if (obj.cwd.startsWith(fromPath + "/")) {
          obj.cwd = toPath + obj.cwd.slice(fromPath.length);
          changed = true;
        }
      }
      if (changed) {
        rewrote += 1;
        return JSON.stringify(obj);
      }
      return line;
    } catch {
      return line; // preserve malformed lines as-is
    }
  });
  return { out: out.join("\n"), rewrote };
}

// Copy src → dst and preserve each file/dir's atime+mtime. Preserving mtime
// matters because `claude --resume` orders sessions by file mtime — without
// this, every migrated session appears "newer" than native sessions in the
// destination slug dir.
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      fs.copyFileSync(s, d);
      const st = fs.statSync(s);
      fs.utimesSync(d, st.atime, st.mtime);
    }
  }
  const st = fs.statSync(src);
  try { fs.utimesSync(dst, st.atime, st.mtime); } catch { /* dir mtime best-effort */ }
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
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
}

function parseArgs(argv: string[]): Args | { help: true } | { error: string } {
  const positional: string[] = [];
  let yes = false;
  let dryRun = false;
  let projectsDir = path.join(os.homedir(), ".claude", "projects");
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "-y" || a === "--yes") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--projects-dir") projectsDir = argv[++i];
    else if (a.startsWith("-")) return { error: `Unknown flag: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 2) return { error: "Expected exactly 2 positional args: <FROM> <TO>" };
  return {
    from: normalizeInputPath(positional[0]),
    to: normalizeInputPath(positional[1]),
    yes,
    dryRun,
    projectsDir,
    json,
  };
}

function printHelp(): void {
  console.log(`cc-migrate-session — migrate Claude Code sessions across folder moves

Usage:
  cc-migrate-session <FROM> <TO> [options]

Arguments:
  <FROM>   Original project path (need not exist any more)
  <TO>     New project path

Options:
  -y, --yes              Execute without interactive confirmation
  --dry-run              Print the plan, do not write
  --projects-dir <dir>   CC projects dir (default: ~/.claude/projects)
  --json                 Machine-readable output (for skill integration)
  -h, --help             Show this help

Examples:
  cc-migrate-session /Users/mark/old-project /Users/mark/new-project
  cc-migrate-session ~/old ~/new --yes
  cc-migrate-session /a /b --dry-run --json
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) { printHelp(); return; }
  if ("error" in parsed) { console.error(`error: ${parsed.error}\n`); printHelp(); process.exit(2); }

  const { from, to, yes, dryRun, projectsDir, json } = parsed;
  const fromSlug = pathToSlug(from);
  const toSlug = pathToSlug(to);
  const fromDir = path.join(projectsDir, fromSlug);
  const toDir = path.join(projectsDir, toSlug);

  const sessions = scanSlugDir(fromDir);

  const plan = {
    from,
    to,
    fromSlug,
    toSlug,
    fromDir,
    toDir,
    sessionCount: sessions.length,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      file: path.basename(s.file),
      lines: s.lineCount,
      size: s.sizeBytes,
      sampleCwd: s.sampleCwd,
    })),
    toDirExists: fs.existsSync(toDir),
  };

  if (json) {
    if (!dryRun && (yes || sessions.length > 0)) {
      // will do real work below and emit final json at end
    } else {
      console.log(JSON.stringify({ phase: "plan", ...plan }, null, 2));
      if (dryRun || sessions.length === 0) return;
    }
  } else {
    console.log(`From : ${from}`);
    console.log(`       slug: ${fromSlug}`);
    console.log(`       dir : ${fromDir}`);
    console.log(`To   : ${to}`);
    console.log(`       slug: ${toSlug}`);
    console.log(`       dir : ${toDir}`);
    console.log("");
    if (sessions.length === 0) {
      console.log(`No sessions found at ${fromDir}`);
      console.log(`(Either the path is wrong, or no CC sessions ever ran there.)`);
      return;
    }
    console.log(`Found ${sessions.length} session file(s):`);
    for (const s of sessions) {
      console.log(`  ${s.sessionId ?? "(no-session-id)"}  ${s.lineCount.toString().padStart(5)} lines  ${formatBytes(s.sizeBytes).padStart(8)}  ${path.basename(s.file)}`);
    }
    if (plan.toDirExists) {
      console.log("");
      console.log(`⚠ Destination already exists: ${toDir}`);
      console.log(`  Existing files will be MERGED; conflicting jsonl files will be OVERWRITTEN.`);
    }
    console.log("");
  }

  if (dryRun) {
    if (!json) console.log("--dry-run: no changes written.");
    return;
  }

  if (!yes) {
    const ans = await prompt(`Proceed? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  // Execute: copy dir, rewrite cwd in each jsonl
  fs.mkdirSync(toDir, { recursive: true });
  let totalRewrites = 0;
  const results: Array<{ file: string; rewrote: number }> = [];
  for (const s of sessions) {
    const dst = path.join(toDir, path.basename(s.file));
    const content = fs.readFileSync(s.file, "utf8");
    const { out, rewrote } = rewriteJsonl(content, from, to);
    fs.writeFileSync(dst, out);
    // Preserve mtime so `claude --resume` orders sessions by actual
    // session recency, not by migration time.
    const srcStat = fs.statSync(s.file);
    fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
    totalRewrites += rewrote;
    results.push({ file: path.basename(s.file), rewrote });
  }
  // Also copy any non-jsonl files (e.g. session sub-dirs, metadata)
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.name.endsWith(".jsonl")) continue;
    const s = path.join(fromDir, entry.name);
    const d = path.join(toDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }

  const firstSessionId = sessions.find((s) => s.sessionId)?.sessionId ?? null;

  if (json) {
    console.log(JSON.stringify({
      phase: "done",
      ...plan,
      rewrites: totalRewrites,
      results,
      restartHint: {
        cd: to,
        command: firstSessionId ? `claude --resume ${firstSessionId}` : `claude --resume`,
      },
    }, null, 2));
  } else {
    console.log("");
    console.log(`✓ Copied ${sessions.length} session(s), rewrote cwd in ${totalRewrites} line(s)`);
    console.log(`✓ Original intact at: ${fromDir}`);
    console.log("");
    console.log("Next step — restart Claude Code in the new location:");
    console.log("");
    console.log(`  cd ${to}`);
    console.log(`  claude --resume${firstSessionId ? `   # then pick a session, or: claude --resume ${firstSessionId}` : ""}`);
    console.log("");
    console.log(`When you've verified the sessions work, you can remove the old dir:`);
    console.log(`  rm -rf ${fromDir}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
