# Subagents

Tool-neutral home for this repo's subagent definitions, laid out the same way as `skills/`: the real
file lives once here, and each tool's directory holds a **symlink** into it.

```
agents/doc-auditor.md                      # canonical
.claude/agents/doc-auditor.md  ->  ../../agents/doc-auditor.md
```

## How this differs from `skills/`

Skills follow a published standard ([agentskills.io](https://agentskills.io)) — the *format* is
shared, only the discovery path differs per tool. **Subagents have no equivalent standard.** Each
tool defines its own frontmatter keys and its own directory, and some have no subagent concept at all.

So the honest scope of "portable" here:

| | Skills | Subagents |
|---|---|---|
| File format | standardized | per-tool |
| Discovery path | per-tool | per-tool |
| Verified here | Claude Code, Codex | **Claude Code only** |

Only `.claude/agents/` is verified — it is the one path checked against a real installation. Do not
add a symlink for another tool until you have confirmed its path against that tool's own docs; a
guessed path is a file that silently never loads.

The bodies are plain Markdown, so a tool without a subagent directory can still use one: point it at
the file (`follow agents/fix-verifier.md`). It loses the tool restriction described below, which is
most of the value, but the instructions still apply.

## Frontmatter

`name`, `description`, and `tools` are the load-bearing keys. `model` and `color` are widely
understood; `effort` is Claude-Code-specific and ignored elsewhere.

**`tools` is the enforcement mechanism, not documentation — but only where it's complete.**
`doc-auditor` holds `Read, Glob, Grep` and nothing else: no `Edit`, no `Write`, and no `Bash`
(a shell is an editor — `sed -i` — so granting Bash would reduce "cannot edit" to a suggestion).
That one is structurally read-only. `fix-verifier` is the honest exception: it needs `Bash` to
derive diffs and run the gates, so its "never modify" rule is prose backed by review of its output,
not structure. This is the same trade Anthropic's own `claude-code-action` repo makes: its reviewer
agents omit write tools where they can, and rely on instruction where the job needs a shell.

## The three agents

| Agent | Writes? | Job |
|---|---|---|
| `doc-auditor` | no | Reads docs against code, returns a claim ledger. Never fixes. |
| `fix-generator` | yes | Implements **one** ledger entry. Never reviews its own work. |
| `fix-verifier` | no | Derives the diff itself, runs the gates, default REJECT. |
| `change-implementer` | yes | Implements **one** formalized fix/feature contract. Never reviews its own work. |
| `change-verifier` | no* | Derives the diff from pre-images, re-proves RED, audits close-out obligations, default REJECT. |

The first three are dispatched by `skills/verify-docs/SKILL.md`, the last two by
`skills/fix-issue/SKILL.md` and `skills/implement-feature/SKILL.md` — none invoked directly.
(*`change-verifier` holds no Edit/Write but does hold Bash for its swap-restore RED check; it must
leave the tree byte-identical, and proving that is part of its own protocol.)

Two design points that are easy to undo by accident:

- **The verifier is dispatched without the generator's reasoning.** Not an efficiency measure — a
  model grades a change framed as its own work measurably softer than the identical change attributed
  elsewhere. Its preflight rejects a dispatch that carries the generator's rationale.
- **The generator never touches git.** This tree carries long-lived uncommitted work, so `git add`,
  `git checkout --`, `git stash` and friends are forbidden outright. The generator records a
  pre-image copy under `RUN_DIR/before/` instead, and that is what the verifier diffs against.
- **A missing toolchain is a refusal, not a degraded mode.** If `node`/`npm` are not on `PATH`, the
  verifier stops and says so. It does not hunt the filesystem for another interpreter, borrow the one
  bundled with an editor server, or review with the gates skipped. Every "run it anyway" path here
  ends in *unknown* being reported as *PASS*, which is the one output that makes this pipeline worse
  than having none.

## Add an agent

```bash
$EDITOR agents/<name>.md                                    # write it
ln -sfn ../../agents/<name>.md .claude/agents/<name>.md     # Claude Code
```

`.gitignore` ignores local agent state (`.claude/*`) but re-includes `.claude/agents/`, so the
symlinks are committable while `settings.local.json` and caches are not.

## Windows caveat

Symlinks need `git config core.symlinks true` (and Developer Mode or admin) on Windows checkouts.
Without it, replace the symlinks with copies kept in sync by a pre-commit hook — the canonical file
under `agents/` stays the source either way.
