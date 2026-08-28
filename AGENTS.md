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
  invocation. Isolation is load-bearing — a bare `bun test` shares one module
  registry across files and the render tests then hang (deadlock, not failure)
  on nearly every run (#27), and two render suites running concurrently in one
  process crash the browser intermittently. One browser-backed suite per
  process is the stable shape; an isolated hang or browser crash is a known
  flake to re-run, not a new bug (#27).
- Model costs: measure from real Gateway billing (`✓` figures only) — never copy from price tables.
- The tool must keep working offline for everything except plate generation.
- Core design decision (model paints background only, text is local CSS —
  ADR-0001): do not move text rendering onto the model.

## Rendering gotchas

If you change `src/compose.ts` rendering, **look at the output image** — the
following bugs were invisible in logs:

- Nested double quotes inside an HTML `style="..."` attribute truncate
  silently — emit a `<style>` block (compose.ts does).
- A block element's `getBoundingClientRect().width` is the container width;
  to detect font fallback, measure an inline element.
- CSS selectors aimed at one path group can hit SVG marker paths too (the
  dashed-arrowhead bug). Scope selectors precisely.
- `vector-effect: non-scaling-stroke` makes `stroke-width` mean CSS pixels —
  fractional widths go sub-pixel and vanish. Connectors use pixel-space SVG.
- A background-clip gradient on `.headline.fill` overrides child `.accent`
  colours unless `-webkit-text-fill-color` is restated on the child.
- In batch sweeps, check the output file list, not just timing — a silenced
  stdout once hid 3 of 4 variants failing to render.
- An `@font-face` rule inside a `:root {}` block is invalid CSS and ignored
  silently — every text element then renders in the default serif while
  layouts and logs look normal. Font-face rules go at the stylesheet's top
  level (compose.ts), and the render probe re-verifies each family resolves.

## Assets and provenance

- Asset requirements for logos, plates, and cutouts (including Kenny's
  likeness rules): `docs/asset-requirements.md` — canonical.
- Creator cutouts must be composited or derived via a single edit pass from
  the identity kit; **never generate his likeness from text alone**.
- Design decisions and their rationale: `docs/adr/`.
