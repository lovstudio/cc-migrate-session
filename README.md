# @lovstudio/cc-migrate-session

> Migrate Claude Code sessions when a project folder moves.

When you `mv /old/project /new/project`, Claude Code's `--resume` flag can no longer find your history. That's because CC keys sessions by a path-slug — so the old history is still on disk at `~/.claude/projects/<old-slug>/`, but CC looks in `<new-slug>/` and finds nothing.

This tool fixes that:
1. Copies `~/.claude/projects/<old-slug>/` → `<new-slug>/`
2. Rewrites every `"cwd"` field inside the jsonl lines from `/old/project` → `/new/project`

After running, `cd /new/project && claude --resume` shows your full history.

## Install / Use

Zero install — just run with `npx`:

```bash
npx -y @lovstudio/cc-migrate-session /old/project /new/project
```

It will show a preview and ask for confirmation. Add `--yes` to skip the prompt, or `--dry-run` to see what it would do without writing.

## Options

| Flag | Purpose |
|------|---------|
| `-y`, `--yes` | Skip interactive confirmation |
| `--dry-run` | Print the plan, don't write |
| `--json` | Machine-readable output (used by the CC skill) |
| `--projects-dir <dir>` | Override `~/.claude/projects` |
| `-h`, `--help` | Show help |

## Examples

```bash
# Interactive
npx -y @lovstudio/cc-migrate-session ~/old-repo ~/new-repo

# Non-interactive, in a script
npx -y @lovstudio/cc-migrate-session ~/old ~/new --yes

# Just tell me what would happen
npx -y @lovstudio/cc-migrate-session /a /b --dry-run
```

## Safety

- **Copy, don't move.** The old slug dir is never deleted. If anything goes wrong you still have your history.
- Malformed jsonl lines are passed through unchanged.
- Destination merge: if `<new-slug>/` already has jsonl files, conflicting names will be overwritten. You'll get a warning.

Verify that `claude --resume` works from the new dir before running `rm -rf ~/.claude/projects/<old-slug>/`.

## How it works

Claude Code stores each session at:

```
~/.claude/projects/<slug>/<session-uuid>.jsonl
```

where `<slug>` is the project's absolute path with every non-`[A-Za-z0-9]` character replaced by `-`:

| Path | Slug |
|------|------|
| `/Users/mark/my-project` | `-Users-mark-my-project` |
| `/Users/mark/.claude` | `-Users-mark--claude` (the `.` → `-`) |
| `/Users/mark/@手工川` | `-Users-mark-----` (`@` plus 3 CJK chars) |

Each jsonl line also embeds `"cwd": "<absolute path>"`. Both the dir name **and** the per-line cwd must be updated for `--resume` to pick up the history — this tool does both.

## Companion CC skill

The `skill/cc-migrate-session/` dir in this repo is a Claude Code skill. Symlink it:

```bash
ln -s $(pwd)/skill/cc-migrate-session ~/.claude/skills/cc-migrate-session
```

Then when you tell Claude "I moved this project to /new/path" or "this project used to be at /old/path", CC will auto-invoke this CLI for you.

## License

MIT
