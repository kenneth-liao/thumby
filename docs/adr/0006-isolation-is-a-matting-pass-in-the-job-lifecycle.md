# ADR-0006: Isolation is a matting pass in the Job lifecycle, not a prompt instruction

- Status: Accepted (from ticket #16, `REQ-017`)
- Context: Creator candidates must reach the library as isolated Cutout Assets with a verified true-alpha matte, but the tested likeness recipe cannot produce one

## Decision

Isolation is a **stage of the creator Generation Job**, run between generation
and adoption:

- Every creator candidate goes through the **matting pass** (`src/matte.ts`)
  as part of its run. The pass produces the candidate's **matte** — true-alpha
  bytes recorded beside the candidate under their own content identity, with
  the engine that produced them.
- The pass takes a **segmentation** route, never a chroma key: an engine
  predicts a subject mask and the mask becomes the candidate's alpha channel
  locally (`composeMatte`). No pixel is ever judged by its colour distance to
  a background.
- A candidate that already carries a real matte is kept as-is
  (`native-alpha`) — no second call, and the adopted bytes are the exact bytes
  the human reviewed.
- **Adoption reads the matte, never the raw candidate.** A candidate without
  one cannot be adopted, and the true-alpha gate (`REQ-015`, `REQ-017`) runs
  again on the bytes that enter the library.

The engine is a seam (`MatteEngine`). The shipped default predicts the mask
through the Gateway (`segmentationMatteEngine`); a local BiRefNet / BEN2 /
RMBG-class runner satisfies the same type and replaces it without touching the
lifecycle, the record, or the gate.

## Rationale

Measured through the recorded creator-job workflow (2026-08-29, `nano-2`,
true transparency requested in-prompt): candidates came back **opaque RGB**
(colour type 2), and one **painted a fake checkerboard** imitating a
transparency indicator. Asking the prompt for transparency is therefore not a
mechanism, and the adoption gate correctly refuses what comes back.

Two shapes were available. Documenting the gap left `jobs creators` a flow
that could never complete — the reviewed contract promised isolated Creator
Assets that the default path could not deliver. Making isolation a lifecycle
stage closes the contract instead: the gap was never in the gate, it was the
missing matte, so the matte is produced where the lineage already lives.

Keeping the matte **beside** the candidate rather than replacing it preserves
best-of-N lineage: the candidate is still the likeness evidence the review
sheet compares against the anchors, and the matte is the isolated form the
review sheet shows and adoption writes. One canonical home each; adoption has
no second path by which opaque bytes could reach the library.

The green-screen route (`#00FF00` + `src/chromakey.ts` + `library add-cutout`)
stays available for hand-keying existing images, but it is **not** the Job
path: RGB colour distance is not a matte, and green fringe on hair is its
known defect.

## Consequences

- `runCreatorJob` / `rerunCreatorJob` require a `MatteEngine` — a creator run
  that could record un-matted candidates is unrepresentable.
- A matting failure does not discard a paid run: the candidate is recorded
  without a matte, the run's warnings say why, and adoption refuses it by name.
- Run cost covers generation **and** matting — including a matting attempt
  that failed *after* its model call returned. Every failure carries its
  billing (`MattingFailure.billing`), so a run can neither understate its cost
  nor claim an unmeasured part was measured.
- Adopted Cutout Assets record `matting: "true-alpha"` and the `matteEngine`.
  No content identity is stored: the Asset's identity is derived from its bytes
  (ADR-0002), and the candidate the matte came from is named by `adoptedFrom`
  alone. The adoption result reports the identity of the bytes written — the
  matte's — so nothing reports a hash that does not identify what it wrote.
- Matte quality per engine is a measurable, replaceable property — swapping
  engines is a one-line change with no lifecycle impact.
