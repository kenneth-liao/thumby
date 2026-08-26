---
trigger: always_on
---

<!-- Context Module: engineering-principles -->
# Engineering Principles & Practices

## Poka-yoke — design so it's impossible to break

Prefer designs where an invalid state **cannot be represented** over designs that detect and handle an invalid state after the fact. When a class of bug appears, fix the *shape* that allowed it, not just the instance. In practice:

- **One canonical home per fact** *(Single Source of Truth).* Every piece of data has exactly one authoritative location. If the same fact can be stored in two places, readers will eventually disagree — and that divergence *is* the bug. A `?? fallback` between two storage locations for the same fact is the smell that this principle is being violated.
- **Normalize at one boundary** *(Parse, Don't Validate).* Untyped or external input becomes trusted internal data at a single ingestion point. Coerce *and relocate* there, so every downstream reader can assume the canonical shape. Adding a new read/comparison site must never require knowing about alternate representations.
- **One reader, not N** *(low coupling / Law of Demeter).* When several call sites need the same derived fact, give them a single shared function to call, so no site can read it the wrong way.
- **Layer the defenses, but make each layer independently sufficient** *(Shift Left / Defense in Depth)* — stop bad input at the creator's machine → reject it at ingestion → tolerate it at comparison → migrate existing data. A later layer is never an excuse to leave the shape breakable.

## Minimal change — the simplest solution that *completely* solves the problem

*(KISS + YAGNI, applied with DRY.)* The standing goal is to **minimize tech debt while solving real problems**. Every change should be the simplest implementation that fully satisfies the requirement — no more, no less:

- **Completeness first, then minimalism.** Writing less code is never the top priority; a change must *completely* solve the problem. Among solutions that all do, prefer the one that adds the least surface (code, config, tests, gates) — less surface is less to drift, less to maintain, less to break.
- **Every artifact solves a real problem.** Don't add tests, gates, or abstractions for their own sake. A test must protect against a failure that can actually happen (ideally one already seen); a gate must block a break that can actually ship. If you can't name the concrete failure it prevents, it's debt, not protection.
- **DRY + poka-yoke are non-negotiable.** A second home for a fact, a duplicated assertion, or a `?? fallback` between two storage locations must be flagged — even when it would be the quicker path. If a change can't satisfy these, surface it rather than quietly shipping the smell.

## Single Responsibility Principle — one reason to change

A module, function, or file should have exactly one reason to change. When two unrelated concerns share a home, a change to one risks breaking the other — and the blast radius is invisible until it happens.

- **One concern per unit.** If you find yourself describing what a function does with "and," it's two functions.
- **Split along reasons to change, not along code size.** A 20-line function doing two unrelated things is worse than a 200-line function doing one.

## Fail Fast — reject invalid states immediately

When a state can't be made unrepresentable (poka-yoke's first choice), reject it loudly at the boundary instead of letting it silently propagate downstream.

- **Validate at the edge, not deep in the call stack.** A check buried three calls deep means everything above it already trusted bad data.
- **Surface the failure, don't swallow it.** An empty catch block or a silently-substituted default turns a real failure into an invisible one — it resurfaces later, somewhere harder to trace back to the cause.

## Test-Driven Development — red, green, refactor

Code changes follow the red-green-refactor loop: write a failing test, write the minimal code to make it pass, then refactor. See the `tdd` skill for the full workflow (tracer bullets, vertical slicing, anti-patterns to avoid).

- **Exceptions:** trivial changes, docs-only changes, and throwaway prototypes/spikes don't require a test-first approach.
- **Use judgment at the edges.** If a "trivial" change is actually easy to get subtly wrong, write the test first regardless of size.
<!-- End Context Module: engineering-principles -->
