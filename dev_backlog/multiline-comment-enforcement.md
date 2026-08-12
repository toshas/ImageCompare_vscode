# Backlog: enforce the one-line-comment rule across the whole codebase

**Status: not started.** This is a plan, and per CLAUDE.md plans are disposable — delete this file
when the work lands, folding anything durable into `CLAUDE.md` / the checker itself.

## The problem, with evidence

CLAUDE.md's rule — *a code comment is one line; if it doesn't fit, it belongs in `docs/`* — is
enforced by `scripts/comment-lint.mjs`, but only over `src/**/*.ts` (the filter on line ~14). The
exemption for `test/` was justified for fixture quirks ("why this byte layout triggers the edge
case"), and that justification is sound. What actually happens, though, is different: commit
`e0e208d` added a 4-line comment to `test/demos/demos.spec.ts` narrating **production behavior**
(the provider's post-crop wire sequence: sparse `tupleAdded` → `fileRestored` per file →
`cropComplete` before thumbnails → images only on `requestImage`). That is protocol knowledge with
no home in `docs/` — documentation hiding where nobody maintains it, the exact failure mode the
rule exists to prevent.

Root cause (agent-behavior diagnosis, worth keeping): **gates shape agent behavior; prose does
not.** A rule expressed as a scoped gate gets obeyed exactly to its scope — every close-out audit
correctly reported "comment-lint: n/a, scans only src/" and moved on. If the rule should hold in
`test/` and `scripts/`, the *checker* has to say so; no amount of CLAUDE.md wording will.

## The plan

1. **Rehome the known offender first.** Move the post-crop wire-sequence narration into
   `docs/crop-and-pptx.md` as a named invariant (candidate key: `post-crop-message-order`), cited
   with one-line comments from both `src/imageCompareProvider.ts` (the code that produces the
   sequence) and `test/demos/demos.spec.ts` (the emulation that would silently drift). This is
   worth doing regardless of the lint change — the sequence is durable protocol knowledge
   documented nowhere.
2. **Sweep before legislating.** Enumerate every existing 2+-line `//` run under `test/**/*.ts`
   and `scripts/**/*.mjs` and classify each: (a) fixture quirk — legitimately co-located, keep;
   (b) production-behavior narration — rehome to `docs/` per step 1's pattern; (c) padding —
   compress to one line. The sweep result decides the threshold in step 3: if legitimate
   fixture explanations routinely need 2–3 lines, a strict 2+ gate would just teach agents to
   write one very long line.
3. **Extend `scripts/comment-lint.mjs`.** Add `test/**/*.ts` and `scripts/**/*.mjs` to the scan,
   with whatever threshold step 2 justified (likely: keep 2+ strict for `src/`, allow up to 3
   lines in `test/`, fail 4+ everywhere). Keep the existing banner/directive exemptions. Note the
   current checker only sees `//` runs — `/** */` blocks are invisible to it; decide explicitly
   whether JSDoc stays exempt (file-header JSDoc in specs is house style) and write that decision
   into the checker's header comment.
4. **Update the prose to match the gate.** Rewrite CLAUDE.md's exemption sentence to state the
   new scope and threshold; the checker and CLAUDE.md must tell the same story or the next agent
   inherits the same split-brain.
5. **Prove the gate bites.** Temporarily add a 4-line comment to a test file and watch the checker
   fail (the repo's own "a green suite is not evidence" discipline applies to checkers too).

## Acceptance

- `node scripts/comment-lint.mjs` scans `src/`, `test/`, `scripts/` and is green in CI.
- CLAUDE.md's comment rule states the same scope/threshold the checker enforces.
- The post-crop wire sequence lives in `docs/crop-and-pptx.md` with citations resolving via
  `check-invariants.mjs`.
- Zero remaining production-behavior narration in test comments (sweep list closed out).
