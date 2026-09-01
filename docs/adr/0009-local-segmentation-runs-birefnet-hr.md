# ADR-0009: Local segmentation runs BiRefNet HR

- Status: Accepted (from ticket #44)
- Context: the local matting pass (ADR-0006) is a pin behind a fixed seam, and
  ticket #44 benchmarked candidate segmenters for cutout quality on real
  headshots (hair edges, profile silhouettes, fingers/watch/tattoo detail).
  BiRefNet HR won the comparison clearly on fine-edge and hair quality; the
  cost is a larger 2048×2048 input and more compute per image

## Decision

The pinned segmenter in `src/segment.ts` is **BiRefNet HR**
(`ZhengPeng7/BiRefNet_HR`, MIT), replacing BiRefNet general fp16 @ 1024². The
benchmark evidence and visual comparisons live in ticket #44.

- **Quality over throughput.** Segmentation is occasional and low-volume; the
  measured ~17 s per image (CoreML MLProgram on the GPU, M4 Pro) is accepted
  where the general model took ~6 s. Note honestly: the benchmark's 3.64 s
  figure was PyTorch MPS, not the `onnxruntime-node` stack ADR-0006 pins —
  ORT's CoreML execution provider is materially slower than MPS for this
  transformer, and that gap is the real price of the upgrade on this stack.
- **The checkpoint ships as PyTorch weights only.** No ONNX export of
  BiRefNet_HR exists upstream (checked 2026-08-31), so thumby produces its own
  with `uv run --locked --script scripts/export-birefnet-hr.py`. The script
  downloads **one immutable Hugging Face revision**
  (`a7a562f6fd16021180f2f4348f4de003a2d3d1e1` — never `main`), verifies the
  checkpoint sha-256 before `trust_remote_code` loads the architecture, traces
  at 2048², converts to fp16 with fp32 I/O, verifies both graphs numerically
  against the PyTorch reference (fp32 ≤ 1e-4 max abs diff; fp16 gated on
  max/mean abs diff and ≥ 99.9% binarised-mask agreement), and prints the
  sha-256 that becomes the pin. Dependencies are exact (`==`) and hashed in
  `scripts/export-birefnet-hr.py.lock`. The pin is the provenance: a weights
  file that does not hash to it is not this model. The existing ONNX artefact
  was produced from this revision and environment (fp32 max abs 1.44e-07,
  fp16 max 1.14e-03 / mean 5.32e-06, 100% binarised agreement).
- **The graph is tidied for CoreML before export.** Two traced artefacts of
  the Swin backbone break the CoreML execution provider: `torch.roll` (the
  cyclic shift) compiles to an op CoreML rejects, and each `BasicLayer`
  rebuilds its attention mask from constant shape ops that fragment the graph.
  The export script replaces roll with a slice+cat decomposition and freezes
  each layer's attention mask (built once per resolution — the multi-scale
  `cat` input path runs every layer at two resolutions) as a graph constant.
  Both transformations are gated against the untouched checkpoint's output
  before tracing. Without this, only a few hundred of 6000+ nodes reached
  CoreML and the pass took ~30 s.
- **The execution provider is configured.** MLProgram + GPU
  (`COREML_FLAG_CREATE_MLPROGRAM | COREML_FLAG_USE_CPU_AND_GPU`): the ANE
  compile fails on a model this large and the default path is slow. CPU
  fallback with a recorded warning stays, unchanged from ADR-0006.
- **The mask is resampled bilinearly onto the candidate.** `composeMatte`
  previously sampled nearest-neighbour. The HR mask is 2048² — twice the
  candidate's typical resolution — so nearest sampling would alias exactly the
  hair-level detail the upgrade exists for. Bilinear coverage interpolation
  (luminance × the mask's own alpha) is what the benchmark's comparison used.

## Consequences

- `models/birefnet-hr-fp16.onnx` (~560 MB) replaces `birefnet-fp16.onnx` in
  the gitignored cache; the old file can be deleted. The pin change is the
  only lifecycle-visible difference: preflight, native-alpha, matte
  verification, and engine recording are untouched (ADR-0006's swap path).
- Re-creating the weights needs `uv` and network access once (~440 MB
  checkpoint download); the export script is the documented, reproducible
  route and doubles as the provenance record.
- The unit suite never loads the weights; the live check in
  `test/segment.test.ts` skips when the cache is absent.
- Swapping the segmenter again remains a pin change plus, if the new model's
  graph carries the same CoreML-hostile artefacts, the same export-script
  treatment.
