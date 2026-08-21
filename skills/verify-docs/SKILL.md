---
name: verify-docs
description: Audit the design docs (docs/*.md, CLAUDE.md, README.md) against the actual code for TRUTHFULNESS — not just that citations resolve, but that every factual claim is true of the code — and fix the drift. Use before a release, after a big refactor, or whenever you suspect the docs no longer match reality. The code is authoritative; a doc that disagrees is wrong. Iterates under a severity + new-drift stopping rule, capped at 3 passes.
---

# Verify docs against code

`scripts/check-invariants.mjs` proves invariants stay *cited*. It proves nothing about whether the
prose is *true*. Every real doc bug found historically — a symbol placed in the wrong file, a VSIX
size off by 2x, a dead dependency list, a wire format documented from a broken parser's imagination,
an invariant whose cited code no longer does the thing — passed the checker and was caught only by an
agent reading the code. **This skill audits the claims a script can't.** Its output is worth nothing
unless every finding is backed by a code quote.

## Principle

**The code is authoritative. Where a doc and the code disagree, the doc is wrong** — unless the doc
describes *intended* behaviour the code violates, in which case it is a **code bug**: surface it, do
not quietly rewrite the doc to match the bug. Assume drift exists; a clean report over a corpus this
size is a suspicious result, not a reassuring one, and must be justified.

## What to verify — every factual claim, not just citations

For each doc, extract its factual claims and check each against the code:

- **Locations** — does `getResultsTarget` actually live where the doc says? (grep, then read the file.)
- **Numbers and values** — suite counts, timeouts, JPEG quality, sizes, priority order, platform
  count, dependency lists, VSIX size — against the real constant/file, never memory.
- **Behaviour** — does the function do what the sentence says? Read it and trace it.
- **Invariant enforcement** — does the cited code site actually enforce the invariant's claim? An
  invariant whose code no longer does the thing is the highest-value find.
- **Absolute quantifiers** — "always", "never", "only", "both", "every". These are where an
  authoritative sentence goes wrong. Count the call sites: "only on the prefetch path" is false if a
  thumbnail path does it too. Every absolute word is a claim to disprove.
- **Cross-references** — every `docs/<file>.md: <key>` citation and section pointer resolves to
  something that exists. (Write example citations with `<…>` placeholders, never a fake doc name like
  `docs/x.md` — the checker scans tracked *and* untracked-but-unignored files, skills included, and
  reads a real-looking citation as a real one.)

## Procedure

Three subagents do the work, and **the orchestrator does none of it directly** — see `agents/README.md`.
Auditing, fixing and judging are separate roles held by separate agents, and the separation is enforced
by their `tools` grants rather than by intention: `doc-auditor` and `fix-verifier` hold no `Edit` or
`Write`, so they cannot fix what they find or rubber-stamp what they wrote.

1. **Partition the docs across `doc-auditor` dispatches** — one per 1-2 docs, each holding its doc(s)
   *and* the referenced code fully in context. Read whole files; do not skim. Create a run directory
   (`.agent-runs/<pass>/`, gitignored) and pass it as `RUN_DIR`.

2. **Each returns a claim ledger** — per claim: the verbatim doc `snippet`, a verdict
   (TRUE / FALSE / STALE / UNVERIFIABLE), a `file:line` quote of the deciding code, a severity, and a
   class. **Quote or it didn't happen** — a verdict without a quote is not a finding and must be
   dropped. Concatenate the ledgers into `RUN_DIR/ledger.json`.

3. **Re-dispatch, don't guess, on `UNVERIFIABLE`.** An auditor that has read the whole function
   usually reaches confidence directly; when it cannot, it says so rather than softening to "probably
   true". The orchestrator then dispatches a fresh `doc-auditor` scoped to that single claim. No claim
   may rest at "probably true" — either confirmed against code, or a finding, or escalated as
   genuinely undecidable. A wrong "TRUE" is the failure this skill exists to prevent.

4. **Classify each confirmed finding:** MECHANICAL (wrong path, stale count, dead link, renamed
   symbol, a claim the code flatly contradicts — unambiguous to fix) vs JUDGMENT (is this behaviour a
   bug or intended? should the invariant be reworded or is the code wrong? is this prose still
   load-bearing?).

## Convergence — the fixpoint (this is why it stops)

Fixing docs changes the docs, which can introduce new claims, so the audit needs a stopping rule.
**Do not use "a pass that produces zero edits".** Prose has no canonical form: a thorough enough
auditor can always find a more precise phrasing, so zero-edits is unreachable in principle and asks
prose to behave like code. Measured on a real run, findings went 38 → 16 → 2 while the bar stayed at
an unreachable point.

Converged when **both** gates pass:

1. **Severity gate** — no surviving finding would mislead a reader into a *wrong action*. A claim that
   is imprecise but leads to the correct behaviour is recorded, not chased. "The list omits one of six
   subsystems" and "the word *only* is too strong" do not block convergence; "this function lives in
   file X" (it doesn't) and "this is enforced by the compiler" (it isn't) do.
2. **New-drift gate** — count findings *caused by the previous pass's own fixes* separately from
   residual first-pass misses. **That** number reaching zero means the process is stable. Residual old
   misses mean the corpus was big, not that the loop is diverging.

```
pass 1: audit → apply MECHANICAL fixes → record open JUDGMENT items
pass 2: re-verify the corrected passages → fix → count how many were NEW drift
… stop when both gates pass, or at the cap.
```

- **Pass 2 is a focused re-verify, not a full re-audit.** Pass 1 already cleared the untouched ~90%;
  pass 2 need only confirm each corrected passage is true *and introduced no new false claim*.
- **Cap at 3 passes.** If the gates still fail at the cap, stop and report — non-convergence is itself
  the finding, and grinding a fourth pass for a wording nit is not worth the tokens. The cap is not
  advisory, and **it binds the orchestrator, not just the subagents**: on a real run the orchestrator
  overrode it seven times and the extra passes produced net regressions. A pass beyond the cap
  happens only when the user types a request for it *after* seeing the cap report — the orchestrator
  deciding "the user would surely want pass 4" is exactly the override this line exists to forbid.
- **Circuit breaker.** Count what share of a pass's findings were *caused by the previous pass's own
  fixes*. **If that share reaches ~1/3, stop immediately**, whatever the pass number — the loop is
  manufacturing its own work faster than it is retiring it, and another pass makes the corpus worse.
- **The last pass is not automatically the best one.** Keep each pass's diff separately under
  `.agent-runs/<pass>/`. When you stop, say which pass's state you are recommending and why; reverting
  to pass 2 is a legitimate outcome.
- **Detect oscillation.** Hash the doc set between passes; if a state repeats (pass k's fix undone by
  pass k+1), stop and name the oscillating claim — two docs disagree and a human must pick.
- JUDGMENT items never block convergence. Escalate them with `AskUserQuestion` (one question per real
  decision, with the code evidence); resolving them is a human-in-the-loop pass, not automated.

### The main generator of new drift — watch for it when fixing

**A rewrite that makes a sentence "more precise" by adding a closed list or an absolute is the single
largest source of new drift.** Both findings at pass 3 of the measured run were exactly this: an
enumeration written *in the paragraph warning against enumerations*, and the word "only" in a sentence
rewritten to remove a *different* overstatement. When fixing:

- Prefer **deleting the second copy** over keeping two copies correct. A list that duplicates what a
  script prints should say "run it — that output is the list", not restate it shorter.
- Treat every new "only / every / never / all / the two X" you write as a claim you must count call
  sites for, exactly as you would when auditing someone else's.

## Fix — one entry, one generator, one verifier

**The orchestrator never applies a fix itself.** Doing so is what made this loop oscillate on a real
run: the same context that wrote the change then judged it, and graded it soft. Per `BLOCKING` ledger
entry, in this order:

1. Dispatch **`fix-generator`** with `REPO_ROOT`, `RUN_DIR`, and that **one** `ENTRY`. It records a
   pre-image under `RUN_DIR/before/` before editing, and it never touches git — this tree carries
   unrelated uncommitted work, so `git add`/`checkout --`/`stash` are forbidden to it outright.
2. Dispatch **`fix-verifier`** with `REPO_ROOT`, `RUN_DIR`, and **the same `ENTRY` only**. Do **not**
   forward the generator's `summary`, rationale, or self-assessment; the verifier's preflight rejects
   a dispatch that carries them. It derives the diff from the pre-image itself and defaults to REJECT.
3. On REJECT, re-dispatch the generator with the verifier's `OBJECTIONS`. **Two attempts, then stop
   and escalate the entry** — a third try on the same entry is where this loop historically starts
   producing regressions rather than fixes.

Batching entries into one generator is the failure to avoid, not an optimization: a diff carrying five
ideas cannot be rejected for one of them, so all five ship. `RECORDED` findings are logged and not
dispatched at all.

**A code bug** (doc describes the intended rule; code violates it) is escalated, never doc-patched to
match the bug. Fixing the code — with the maintainer's ok — beats weakening the doc.

## Verify after each fixing pass

Each `fix-verifier` already ran these against its own entry; this is the pass-level gate that catches
what only shows up once every entry has landed together. All must pass — run them, don't assume:
```
node scripts/check-invariants.mjs      # every invariant cited, every citation resolves
node scripts/comment-lint.mjs          # no multi-line // blocks in src/ or scripts/ (test/ exempt)
npm test                               # the suites listed in package.json
node scripts/mutation-check.mjs        # the suites actually pin their rules
npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.webview.json
```
Confirm no agent left a file mid-edit (`git status`).

**If `node` or `npm` is not on `PATH`, abort the pass and say so.** Do not locate another interpreter,
do not use one bundled with an editor server, and do not report a pass whose gates were skipped — an
unverified pass reported as clean is the worst output this skill can produce. A broken toolchain is a
finding to hand back, not an obstacle to route around.

## Then reduce

Drift often means the doc said too much. If a claim was cut because a **type, test, or the checker now
enforces it**, delete the prose — don't leave both. Keep only the *why* a competent reader couldn't
reconstruct from the code. A shorter doc is less surface to drift on the next run.

## Report

State the fixpoint outcome (reached in N passes / capped / oscillating), the ledger of confirmed
findings with quotes, what was auto-fixed, what was escalated and why, and — if the report is short —
why you believe the docs are actually clean rather than under-audited.
