# Agent Skills

Tool-neutral home for this repo's [Agent Skills](https://agentskills.io) — the open standard
(Anthropic, Dec 2025) for on-demand agent capabilities, supported by Claude Code, Codex, Copilot,
Cursor, Gemini CLI, VS Code, and others.

Each skill is a folder with a `SKILL.md` (YAML frontmatter `name`/`description` + a Markdown body of
instructions). The agent loads only the name/description at startup and reads the full body when a
task matches — "progressive disclosure".

## Why this layout

The **format** is standardized; the **discovery path is not** — every tool scans its own directory,
and no single folder is read by all of them:

| Tool | Skills dir |
|---|---|
| Claude Code | `.claude/skills/` |
| Codex | `.agents/skills/` |
| GitHub Copilot | `.github/skills/` |

So the real skill lives once here, under `skills/`, and each tool's directory holds a **symlink** into
it. One source of truth, every tool discovers it:

```
skills/verify-docs/SKILL.md                       # canonical
.claude/skills/verify-docs  ->  ../../skills/verify-docs
.agents/skills/verify-docs  ->  ../../skills/verify-docs
```

## Add a skill

```bash
mkdir -p skills/<name> && $EDITOR skills/<name>/SKILL.md      # write the skill
ln -sfn ../../skills/<name> .claude/skills/<name>            # Claude
ln -sfn ../../skills/<name> .agents/skills/<name>            # Codex
# optional: Copilot also reads .claude/skills and .agents/skills
```

`.gitignore` ignores local agent state (`.claude/*`, `.agents/*`) but re-includes the `skills/`
subdirs, so the symlinks can be committed while `settings.local.json` and caches cannot.

## Subagents live next door

`agents/` uses the same canonical-plus-symlink layout for the subagents the skills dispatch
(`verify-docs`, `fix-issue`, `implement-feature`), but
it is a weaker guarantee: skills share a published format across tools, subagents do not. See
`agents/README.md`.

## Windows caveat

Symlinks need `git config core.symlinks true` (and Developer Mode / admin) on Windows checkouts. If
the repo must support Windows contributors without that, replace the symlinks with copies kept in sync
by a pre-commit hook — the canonical file under `skills/` stays the source either way.
