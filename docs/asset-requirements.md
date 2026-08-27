# Asset Requirements

How assets for the library are sourced and prepared, so everything in
`assets/` meets the same bar. These are requirements for Kenneth's own use;
assets are gitignored, so this doc is the standard others can copy.

## Output target

The final thumbnail is always **1280×720** (YouTube 720p, 16:9). Every sizing
rule below derives from that canvas.

## Logos

### Resolution — SVG first, else ≥512×512

**Recommendation: go larger than 256 and scale down at compose time.**

The math: an overlay card is typically `w: 10–12` (percent of frame width),
so ≈128–154px wide on the 1280px canvas. The mark occupies 52% of the card,
so a logo **renders at roughly 65–80px**. But:

- Retina review screens display the image at 2×, so effective demand is
  ~160px.
- Bigger focal cards (`w: 14+`) or a future 4K export silently raise the
  bar; a 256px source is already at its limit with zero headroom.
- Downscaling from a larger source is free and always looks good;
  upscaling a too-small source is blur that no flag can fix.

So the rule is:

| Priority | Format | Requirement |
|---|---|---|
| 1 | **SVG** | Single-path or clean group structure, `viewBox` present, no embedded rasters, no fixed `width`/`height` (the composer strips them). Recolourable = one fill colour, or fills we may override. |
| 2 | **PNG** | ≥ **512×512**, transparent background, logo centred with ~5% padding, no drop shadow baked in. |
| last resort | JPG/WebP | Only when transparency genuinely doesn't exist for the mark. ≥512px. |

256×256 is *adequate* for today's card sizes but is the floor, not the
target — accept it only when nothing larger exists.

### Other logo requirements

- **Transparent background** — the mark sits on glass tiles over arbitrary
  plates; a white box behind it breaks the constellation look.
- **Both light and dark variants when the mark isn't a single path** —
  multi-colour marks (Gemini, Slack) need a version that reads on dark
  tiles. Single-colour marks get recoloured by `markColor` instead, so one
  SVG suffices.
- **Simple-icons / official brand kits first.** For well-known marks, prefer
  the official press/brand page or simpleicons.org over scraping PNGs —
  cleaner paths, known licensing.
- **Record the source** in `meta.json` (`"source"` field): URL and date. If
  a logo ever renders wrong we need to know where it came from.
- **Verify before adopting**: add it, render one test thumbnail with the
  logo on a card, and *look at the image* (per HANDOFF.md — rendering bugs
  are invisible in logs). A corrupt file like the old `openai-color.svg`
  (a 94-byte JSON error blob) must die here, not in a render.

## Plates

Plates are AI-generated at **1536×864** (exact 16:9), so they already exceed
the output canvas — adopt freely. Requirements when adopting:

- The plate's `run.json` must sit beside it (provenance: prompt, model) —
  `bun run library adopt` carries it forward automatically and warns when
  it can't.
- No text baked into the plate; the headline layer is ours.
- Prefer adopting plates that used `--zone`, so their calm half is known
  and searchable (`subject` field).

## Naming and metadata

- **id**: lowercase, digits, hyphens (`openai`, `neon-terminal`). The
  directory name must equal the `id` in `meta.json` — the scanner enforces
  this.
- **tags**: always include at least one category tag (`ai`, `devtools`,
  `google`, `neon`, `studio`…). Tags are half the search experience; an
  untagged asset is invisible to `library list <tag>`.
- **aliases**: record common alternative names (`chatgpt` → `openai`) so
  overlay specs work however you remember the name.
- **One image per directory** — the scanner rejects multiple image files.

## Workflow

```bash
bun run library add-logo <file> --id <id> --name <Name> --tags <csv> --color <hex> --alias <csv>
bun run library adopt <plate.png> --id <id> --tags <csv>
bun run library list --sheet      # visual check: open assets/index.html
```

Then render one test thumbnail using the new asset and inspect the PNG
before considering it adopted.
