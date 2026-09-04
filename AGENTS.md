# AGENTS.md

## Agent skills

### Issue tracker

GitHub Issues via the best available GitHub interface (`gh` as portable fallback). Claim work with
`gh issue edit <number> --add-assignee @me`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default roles mapped 1:1: category `bug`/`enhancement`, artifact `spec`, readiness/disposition
`needs-triage`, `needs-info`, `ready-for-tickets`, `ready-for-agent`, `ready-for-human`, `wontfix`.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.

## Conventions

- `bun`, not npm. `uv`, not pip.
- Tests: `bun run test` — every test file runs in its own `bun test --isolate`
  invocation. One browser-backed suite per process is the stable shape; the
  per-file topology is green on both Bun 1.3.14 and ≥1.4.0. The underlying
  single-process deadlock (#27) was Bun's CDP-pipe defect (oven-sh/bun #15679,
  fixed in Bun 1.4.0): on Bun ≥1.4.0 a bare single-process `bun test` over the
  whole suite is verified 10/10, so `--isolate` is defense-in-depth (module
  isolation), not a flake mask. On Bun 1.3.14 the single-process topology
  still hangs (~60% of runs) — upgrade with `bun upgrade` before trusting a
  bare `bun test`. The shared render page (`src/browser.ts` withRenderPage)
  serializes and self-heals; a hung or crashed run is worth reporting, not
  silently re-running.
- Model costs: measure from real Gateway billing (`✓` figures only) — never copy from price tables.
- The tool must keep working offline for everything except generation itself.
  Creator isolation is local inference (BiRefNet via `onnxruntime-node`,
  ADR-0006): weights are cached under `models/` (gitignored), pinned by
  sha-256 in `src/segment.ts`, and never loaded by the unit suite — tests
  inject a fake `MatteEngine`, and the live check in `test/segment.test.ts`
  skips when the weights are absent.
- Core design decision (models produce source Assets, while text and final
  composition render locally — ADR-0001/0004): do not move final text or the
  final composite onto the model.

## Rendering gotchas

If you change `src/scene-render.ts`, **look at the output image** — these bugs
can be invisible in logs:

- Nested double quotes inside an HTML `style="..."` attribute truncate
  silently. Prefer stylesheet rules or carefully escaped attributes.
- A block element's `getBoundingClientRect().width` is the container width;
  to detect font fallback, measure an inline element.
- CSS selectors aimed at one path group can hit SVG marker paths too. Scope
  selectors precisely.
- `vector-effect: non-scaling-stroke` makes `stroke-width` mean CSS pixels;
  fractional widths go sub-pixel and vanish. Connectors use pixel-space SVG.
- In batch renders, check the output file list, not just timing.
- An `@font-face` rule inside a `:root {}` block is invalid CSS and ignored.
  Font-face rules go at the stylesheet's top level, and the render probe must
  re-verify that each requested family resolves.

## Assets and provenance

- Generation references are arbitrary local image files supplied by the
  caller. Preserve their order, derive their sha-256 identities once at Job
  creation, and verify/read their bytes once at generation.
- Creator generation requires at least one caller-supplied `identity`
  reference; never generate a likeness from text alone.
- Design decisions and their rationale: `docs/adr/`.
