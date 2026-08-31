# ADR-0006: Isolation is a local matting pass in the Job lifecycle

- Status: Accepted (from ticket #16, `REQ-017`); amended from ticket #20 — object candidates run the same pass
- Context: Creator candidates must reach the library as isolated Cutout Assets with a verified true-alpha matte, but the tested likeness recipe cannot produce one. Ticket #20 measured the same for object candidates: `gpt-image-2` paints even a checkerboard backdrop rather than returning alpha, so an opaque object could never be adopted

## Decision

Isolation is a **stage of the creator Generation Job**, run between generation
and adoption, and it runs **locally**:

- Every creator candidate goes through the **matting pass** (`src/matte.ts`)
  as part of its run. The pass produces the candidate's **matte** — true-alpha
  bytes recorded beside the candidate under their own content identity, with
  the engine that produced them.
- **Amendment (ticket #20):** object candidates run the same pass. `REQ-015`
  already named segmentation-quality matting as an object's isolation route,
  and the measured reality is that image models return objects opaque. An
  object candidate adopted through its matte carries the matte's identity and
  records the engine; a natively isolated candidate is kept as-is.
- The engine is a **local ONNX subject segmenter** (`src/segment.ts`):
  BiRefNet (MIT), fp16, run through `onnxruntime-node` with the CoreML
  execution provider on Apple silicon and CPU otherwise. The predicted mask
  becomes the candidate's alpha channel through `composeMatte`. No pixel is
  judged by its colour distance to a background.
- **Likeness generation stays on the Gateway** (`nano-2`). Isolation does not:
  no second billed image-model hop, and no candidate bytes leave the machine
  at matting time.
- A candidate that already carries a real matte is kept as-is
  (`native-alpha`) — no inference, and the adopted bytes are the exact bytes
  the human reviewed.
- **Adoption reads the matte, never the raw candidate.** A candidate without
  one cannot be adopted, and the true-alpha gate (`REQ-015`, `REQ-017`) runs
  again on the bytes that enter the library.

Weights are not in the repo. They live in a gitignored cache (`models/`,
overridable with `THUMBY_MODEL_DIR`), pinned by exact filename and sha-256 and
verified once per process. A missing or wrong-bytes model **fails loudly**
with the path, the pin, and the fetch command; the pass never silently skips
isolation.

That check runs **before anything is paid for**. The seam carries an optional
`preflight`, and the lifecycle calls it ahead of the generation call on both a
new run and a rerun: an engine that cannot run stops the job while it is still
free. Detecting it after generation would leave billed candidates that can
never be isolated, recoverable only by paying again.

## Rationale

Measured through the recorded creator-job workflow (2026-08-29, `nano-2`,
true transparency requested in-prompt): candidates came back **opaque RGB**
(colour type 2), and one **painted a fake checkerboard** imitating a
transparency indicator. Asking the prompt for transparency is not a mechanism,
and the adoption gate correctly refuses what comes back. The gap was never in
the gate — it was the missing matte — so the matte is produced where the
lineage already lives.

Local inference is the right home for it, and not only on cost:

- **A billed second hop creates a class of bug that local inference does not
  have.** When the matte came from a Gateway image model, a call could be
  billed and *then* fail in composition or verification, so the run had spend
  to lose and a measured/unmeasured cost split to get wrong. Running locally
  removes the failure class rather than accounting for it: a matting attempt
  spends nothing, so `costUsd` is generation-only and a failed attempt costs
  the run nothing.
- **A segmentation model is the right tool.** An image model asked for a mask
  is a generative approximation of a segmentation task; BiRefNet is trained
  for exactly this and produces a real soft matte on hair.
- **Determinism and privacy.** The same candidate mattes to the same bytes,
  offline, and a likeness never crosses the network for isolation.

The cost is a large third-party artefact and a native dependency
(`onnxruntime-node`). Both are acceptable here: the target machine is a
MacBook Pro M4 Pro, this repo is Kenneth's own tooling and is not distributed,
and the weights are cached once and pinned by hash.

Keeping the matte **beside** the candidate rather than replacing it preserves
best-of-N lineage: the candidate is still the likeness evidence the review
sheet compares against the anchors, and the matte is the isolated form the
review sheet shows and adoption writes.

The green-screen route (`#00FF00` + `src/chromakey.ts` + `library add-cutout`)
stays available for hand-keying existing images, but it is **not** the Job
path: RGB colour distance is not a matte, and green fringe on hair is its
known defect.

## Consequences

- `runCreatorJob` / `rerunCreatorJob` require a `MatteEngine` — a creator run
  that could record un-matted candidates is unrepresentable. Tests inject a
  fake engine; the real weights are never loaded by the unit suite.
- Run cost is **generation only**: nothing about matting is billed, so there
  is no matting spend to record, to lose on failure, or to mis-measure.
- First use on a machine needs the pinned weights cached (~490 MB, fetched
  once). Missing weights stop the job **before the generation call**, with the
  exact command to fix it — no candidate is ever paid for that the pass cannot
  isolate.
- A matting failure does not discard a paid run: the candidate is recorded
  without a matte, the run's warnings say why, and adoption refuses it by name.
- `onnxruntime-node` is a dependency with a native postinstall
  (`trustedDependencies`); the segmenter falls back from CoreML to CPU with a
  recorded warning rather than failing.
- Adopted Cutout Assets record `matting: "true-alpha"` and the `matteEngine`.
  No content identity is stored: the Asset's identity is derived from its
  bytes (ADR-0002), and the candidate the matte came from is named by
  `adoptedFrom` alone. The adoption result reports the identity of the bytes
  written — the matte's.
- Swapping the segmenter (a newer BiRefNet, RMBG-2.0, a different export) is a
  pin change behind the same seam, with no lifecycle or gate impact.
