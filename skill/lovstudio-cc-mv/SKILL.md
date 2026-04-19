---
name: lovstudio:cc-mv
description: Move a project folder AND migrate all its Claude Code state in one shot — session store, prompt-up-arrow history, running-session records. Use whenever the user wants to rename/move a project directory and keep `claude --resume` working. Handles sub-directory sessions automatically. 移动/重命名项目目录并迁移所有 CC 历史（session + prompt 历史 + 运行记录）。
when_to_use: |
  User wants to move or rename a project directory AND keep CC history working.
  Examples:
  - "把这个项目移到 X" / "把项目从 A 搬到 B" / "rename this folder to X" / "mv this repo to X"
  - "本项目之前是在 X" / "这个项目原来在 X" (post-move recovery — use --no-mv or the cc-migrate-session alias)
  - "claude --resume 找不到" / "cc --resume 找不到历史" / "恢复旧会话"
  NOT for file/function/branch renames — only project root dir moves.
license: MIT
compatibility: claude-code
---

# lovstudio:cc-mv

One command, four things:

1. `mv FROM TO` on disk (fs.renameSync — instant, preserves everything)
2. Rewrites `~/.claude/projects/<slug>/*.jsonl` session store — including every sub-directory slug
3. Rewrites `~/.claude/history.jsonl` (prompt up-arrow recall)
4. Rewrites `~/.claude/sessions/*.json` (running-session records)

After this, `cd TO && claude --resume` sees all prior sessions. The old slug dirs are left intact as a safety net.

## When to Trigger

**YES** — invoke this skill when:
- User wants to move/rename a project folder (prospective move — we do the mv)
- User already moved the folder externally and CC lost history (post-move recovery — use `--no-mv` or the `cc-migrate-session` alias bin)
- User mentions sub-projects under a folder also having history — this is handled automatically

**NO** — don't invoke when:
- Renaming a file, function, variable, or branch (not the project root)
- General question about CC's storage model (explain, don't migrate)
- Paths are ambiguous — ask first

## Workflow

### Step 1 — Gather FROM and TO

| User said | FROM | TO |
|-----------|------|----|
| "把 /a 搬到 /b" / "mv /a to /b" | /a | /b |
| "rename ~/foo to ~/bar" | ~/foo | ~/bar |
| "this project used to be at /old" (cwd is the new location) | /old | `process.cwd()` |
| "本项目已迁移到 /new" (cwd is the old location) | `process.cwd()` | /new |

If either side is ambiguous, **ask once** with `AskUserQuestion`. Don't guess.

Always expand `~` and resolve to absolute paths before running the CLI.

### Step 2 — Dry-run + json to preview

```bash
npx -y @lovstudio/cc-mv <FROM> <TO> --dry-run --json
```

Parse the JSON. Tell the user:
- Total sessions and affected slug count (`pairs[*]` with `sessionCount > 0`)
- If `pairs.length > 1`: flag that sub-directories also have CC history
- If `toDirExistsOnDisk` and FROM also exists: warn — CLI will refuse the fs mv
- If any `pairs[i].toSlugDirExists`: warn — destination slug dir will be merged

If `totalSessions === 0` AND the user wanted post-move recovery (FROM path doesn't exist): stop, tell them either (a) FROM path is wrong, or (b) CC never ran there.

### Step 3 — Confirm

If there are sub-dirs with sessions, ask: "Found N sub-dir(s) with CC history. Migrate everything? [Y/n]" — default yes.

If straightforward (just root dir): inline y/n suffices.

### Step 4 — Execute

```bash
npx -y @lovstudio/cc-mv <FROM> <TO> --yes --json
```

For post-move recovery (FROM already moved externally):

```bash
npx -y @lovstudio/cc-mv <FROM> <TO> --yes --no-mv --json
# OR equivalently:
npx -y @lovstudio/cc-migrate-session <FROM> <TO> --yes --json
```

Parse `phase: "done"`:
- `result.slugsMigrated`, `result.cwdRewrites`, `result.historyRewrites`, `result.runningSessionRewrites`
- `fsMvMethod`: `"rename"` (instant, same-fs) or `"shell-mv"` (cross-device)
- `restartHint.cd` + `restartHint.command`

### Step 5 — Tell user to restart CC

Output something like:

```
✓ Moved FROM → TO and migrated N session(s) across M slug dir(s).
✓ Also rewrote prompt history and running-session records.

Restart Claude Code in the new location:

  cd <TO>
  claude --resume

(The old slug dirs at ~/.claude/projects/<old-slug>* are untouched — delete
them once you've verified --resume works.)
```

**IMPORTANT**: The CURRENT Claude Code session cannot "switch" its own cwd mid-session. The user must exit and re-invoke `claude` from the new directory. State this clearly.

## CLI Reference

`npx -y @lovstudio/cc-mv <FROM> <TO> [options]`

| Option | Purpose |
|--------|---------|
| `-y`, `--yes` | Skip confirmation prompt |
| `--dry-run` | Show plan, don't write |
| `--no-mv` | Skip the filesystem mv (only migrate CC state — post-move recovery) |
| `--json` | Machine-readable output (use this from the skill) |
| `--projects-dir <dir>` | Override CC projects dir (default `~/.claude/projects`) |

### Backwards-compatible alias

`npx -y @lovstudio/cc-migrate-session <FROM> <TO>` — same tool, but defaults to `--no-mv` (only migrates CC state, doesn't touch the filesystem). Use when the user already moved the folder externally.

## Sub-directory Discovery

CC's slug rule is: replace every non-`[A-Za-z0-9]` with `-`. So `FROM/sub` slugifies to `<fromSlug>-<subSlug>`.

The CLI lists `~/.claude/projects/` and takes every slug matching `slug === fromSlug || slug.startsWith(fromSlug + "-")`. That catches FROM and all descendants in one readdir. It then reads each slug's first jsonl to recover the original absolute sub-path (since slug → path isn't reversible), builds the migration pair, and proceeds.

## Safety

- **Old slug dirs are never deleted.** Copy-then-rewrite. Old state survives.
- fs mv refuses if TO already exists on disk (avoid overwrite).
- Slug-dir merging is default when dest slug dir exists — conflicting jsonls overwritten.
- Malformed jsonl lines are passed through unchanged.

Tell the user to verify `claude --resume` works at TO before `rm -rf` of old slug dirs.
