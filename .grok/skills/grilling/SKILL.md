---
name: grilling
description: Grill the user about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview until you can produce the requested artifact with no load-bearing surprises. Completeness is not the goal.

## What to ask

Ask only decisions that would change the artifact: goal, non-goals, constraints, irreversible or cross-cutting design, and vocabulary.

Do not ask implementation details, rare flows, optimizations, or anything the user can decide at use time. Choose a sensible default, put it on the **park list**, and move on.

Each park-list entry is one of:

- **Assumed** — this artifact uses your default
- **Later** — follow-up ticket, not this artifact

## Rounds

Map decisions as a tree. The **frontier** is every unasked decision whose prerequisites are settled **and** that would change the artifact.

Normally **3 rounds**. A **4th** only if a load-bearing decision still blocks the artifact. At most **5 questions per round**.

Ask the whole frontier in one round. Number each question and give your recommended answer. Wait for answers before the next round. A question that depends on another still open in this round belongs to a later round.

```
❓ **Q1** - **<title>**: <body, including choices>

➡️ <recommended answer>
```

The user may accept a whole round's recommendations in one line.

Finding facts is your job — look them up, don't ask. The decisions are the user's.

## Stop

The session is done when the next frontier is only parkable, or the round budget is spent. List the park list. Confirm shared understanding. If they asked for a spec, run `/to-spec`. Do not act on the plan until they confirm.

## Zoom-out

If the user says the questions are too deep, too many, overkill, in the weeds, overengineering, or that something is their responsibility or a later ticket: you may ask **0–3** more questions, only for decisions that would otherwise block or surprise. Then list the park list and produce the artifact.
