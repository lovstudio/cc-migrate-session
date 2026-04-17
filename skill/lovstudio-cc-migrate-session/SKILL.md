---
name: lovstudio:cc-migrate-session
description: |
  Migrate Claude Code session history when a project folder has moved, been renamed, or the user notices `claude --resume` (or `cc --resume`) no longer shows their history. ALWAYS trigger this skill when the user's message mentions any of these situations, even if phrased indirectly.

  Trigger phrases — Chinese (match any of these shapes, including near-synonyms):
    - 本项目/这个项目/这个仓库 + 之前是在/原来在/原本在/以前在/以前是在/本来在/最早在 + <path>
    - 我把(这个)项目/仓库 + 搬到/迁移到/移动到/挪到/换到 + <path>
    - (项目/文件夹)从 X 移动到/搬到/迁到 Y
    - 换(了)位置了 / 改(了)地方了 / 重命名(了)
    - claude --resume / cc --resume / --resume 找不到(旧/之前的) session/历史/会话/记录
    - 恢复(旧/之前的) session/历史/会话
    - 历史(会话)丢了/不见了/没有了
    - 移(动/走)了(文件夹/项目)之后 + (session/历史)没了/看不到了
  Trigger phrases — English (match any of these shapes, including near-synonyms):
    - this project (was|used to be|was previously|originally was|is originally) at <path>
    - I (moved|relocated|renamed) (the|this) (project|repo|folder) (from X )?to Y
    - my sessions are gone after moving the folder
    - `claude --resume` / `cc --resume` doesn't show my history
    - can't find (old|previous) sessions
    - recover / restore (old|previous) Claude Code sessions

  ALSO TRIGGER when the user mentions an old and a new absolute path in the same breath and laments about missing session history — even without the exact phrases above. Ask for the missing side if only one path is given.

  DO NOT trigger for: file renames, function renames, branch renames, git history rewrites — only for the project ROOT directory having moved on the filesystem.
license: MIT
compatibility: claude-code
---

# lovstudio:cc-migrate-session

Moves the session store `~/.claude/projects/<slug>/` from the old path-slug to the new one and rewrites every `"cwd"` field inside the jsonl files. After this, `claude --resume` from the new directory will see all prior sessions.

## When to Trigger

**YES** — invoke this skill when:
- User says the project folder moved / was renamed at the filesystem level
- User mentions both FROM and TO paths, OR mentions one and the current cwd implies the other
- User complains that `claude --resume` no longer shows history after moving a folder
- User wants to "recover" sessions from a path they used to work in

**NO** — don't invoke when:
- User is renaming a file, function, variable, or branch (not the project root)
- User is asking a general question about CC's storage model (just explain, don't migrate)
- Paths are ambiguous — ask first

## Workflow

### Step 1 — Gather FROM and TO

Infer from the conversation first. Typical patterns:

| User said | FROM | TO |
|-----------|------|----|
| "我把项目从 /a 搬到了 /b" | /a | /b |
| "this project used to be at /old" (in new cwd) | /old | `process.cwd()` (current) |
| "本项目已迁移到 /new" (in old cwd) | `process.cwd()` (current) | /new |
| "I renamed ~/foo to ~/bar" | ~/foo | ~/bar |

If either side is ambiguous, **ask once** with `AskUserQuestion`. Don't guess.

**Always** expand `~` and resolve to absolute paths before running the CLI.

### Step 2 — Run dry-run + json to preview

```bash
npx -y @lovstudio/cc-migrate-session <FROM> <TO> --dry-run --json
```

Parse the JSON. Tell the user:
- How many sessions were found
- Total size
- Warn if `toDirExists` is true (destination slug dir already exists — merge risk)
- Show the FROM and TO slugs so the user can sanity-check the path mapping

If `sessionCount === 0`, stop. Tell the user either (a) the FROM path is wrong, or (b) CC never ran there. Do NOT proceed.

### Step 3 — Confirm with user

Use `AskUserQuestion` (or inline yes/no) asking: "Migrate N sessions from <FROM> to <TO>?"

Only proceed on explicit yes.

### Step 4 — Execute

```bash
npx -y @lovstudio/cc-migrate-session <FROM> <TO> --yes --json
```

Parse `phase: "done"` output. Extract:
- `rewrites` (total cwd lines changed)
- `restartHint.cd` and `restartHint.command`

### Step 5 — Tell user to restart CC

Output something like:

```
✓ Migrated N session(s), rewrote M cwd lines.

To load them, restart Claude Code in the new location:

  cd <TO>
  claude --resume

(The original session dir at ~/.claude/projects/<old-slug>/ is untouched —
you can delete it after verifying the new location works.)
```

**IMPORTANT**: The CURRENT Claude Code session (the one running this skill) cannot "switch" its own cwd mid-session. The user must exit and re-invoke `claude` from the new directory. State this clearly.

## CLI Reference

`npx -y @lovstudio/cc-migrate-session <FROM> <TO> [options]`

| Option | Purpose |
|--------|---------|
| `-y`, `--yes` | Skip confirmation prompt |
| `--dry-run` | Show plan, don't write |
| `--json` | Machine-readable output (use this from the skill) |
| `--projects-dir <dir>` | Override CC projects dir (default `~/.claude/projects`) |

## Slug Rule (FYI)

CC computes the slug by replacing every non-alphanumeric character with `-`. So:
- `/Users/mark/my-project` → `-Users-mark-my-project`
- `/Users/mark/.claude` → `-Users-mark--claude` (double `-` because `.` is non-alnum)
- `/Users/mark/@手工川` → `-Users-mark-----` (one per `@` and each CJK char)

The CLI handles this automatically — don't try to hand-compute it.

## Safety

- The old dir is NEVER deleted by this skill. It's a copy-then-rewrite, not a move.
- Tell the user to verify `claude --resume` works in the new location before rm'ing the old slug dir.
- If destination slug dir already exists, the CLI merges (overwriting conflicting jsonls). Warn the user.
