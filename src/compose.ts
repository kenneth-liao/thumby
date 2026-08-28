import { STYLES, type StylePreset } from "./styles.js";
import {
  resolvePairing,
  fontFaceCss,
  familyResolved,
  type Pairing,
} from "./fonts.js";
import { renderOverlay, type OverlaySpec } from "./overlay.js";
import { getBrowser } from "./browser.js";
import type { TextZone } from "./generate.js";

export const WIDTH = 1280;
export const HEIGHT = 720;

export interface ComposeSpec {
  plate: { bytes: Uint8Array; mediaType: string };
  headline: string;
  eyebrow?: string;
  sub?: string;
  type: string;
  /** Transparent PNG (a person cutout) composited over the plate, under the text. */
  cutout?: { bytes: Uint8Array; mediaType: string };
  cutoutSide: "left" | "center" | "right";
  /** Height as a fraction of the 720px frame. */
  cutoutScale: number;
  cutoutGlow?: string;
  /** Overrides the text column width, e.g. "38%". */
  textWidth?: string;
  /** Horizontal nudge for the cutout, in percent of frame width. */
  cutoutX: number;
  /** Mirror the cutout horizontally, e.g. to reverse which way it points. */
  cutoutFlip?: boolean;
  /** Second colour for a gradient headline fill. */
  fillTo?: string;
  /** Floating logo cards and connectors drawn over the plate. */
  overlay?: OverlaySpec;
  style: string;
  zone: TextZone;
  accent: string;
  fill: string;
  stroke: string;
}

/** `*word*` marks an accent-colored run. Everything else is escaped. */
function markup(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/(\*[^*]+\*)/g)
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith("*") && chunk.endsWith("*") && chunk.length > 2
        ? `<span class="accent">${escape(chunk.slice(1, -1))}</span>`
        : escape(chunk),
    )
    .join("")
    .replace(/\n/g, "<br>");
}

function page(
  spec: ComposeSpec,
  preset: StylePreset,
  font: Pairing,
  plateUri: string,
  cutoutUri: string | null,
  overlay: Awaited<ReturnType<typeof renderOverlay>> | null,
): string {
  const head = markup(spec.headline);
  const zonePad: Record<TextZone, string> = {
    left: "justify-content:flex-start; align-items:flex-start;",
    right: "justify-content:flex-end; align-items:flex-start;",
    bottom: "justify-content:flex-start; align-items:flex-end;",
    none: "justify-content:flex-start; align-items:center;",
  };
  // Text gets the calm half the plate prompt reserved for it.
  const boxWidth =
    spec.textWidth ??
    (spec.zone === "left" || spec.zone === "right" ? "56%" : "100%");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  ${fontFaceCss(font.display, font.sans)}
  :root {
    --accent: ${spec.accent}; --fill: ${spec.fill}; --stroke: ${spec.stroke};
    --bar-ink: #0b0b0d; --stroke-w: 8px;
    --font-display: "${font.display.family}";
    --font-sans: "${font.sans.family}";
    --tracking: ${font.tracking};
  }
  body { width:${WIDTH}px; height:${HEIGHT}px; overflow:hidden; position:relative; }
  .plate { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  .cutout { position:absolute; bottom:0; height:${Math.round(spec.cutoutScale * HEIGHT)}px;
            width:auto; object-fit:contain; object-position:bottom;
            ${
              spec.cutoutSide === "left"
                ? `left:${2 + spec.cutoutX}%;`
                : spec.cutoutSide === "right"
                  ? `right:${2 - spec.cutoutX}%;`
                  : `left:${50 + spec.cutoutX}%;`
            }
            transform:${spec.cutoutFlip ? "scaleX(-1)" : "none"}${spec.cutoutSide === "center" ? " translateX(-50%)" : ""};
            ${spec.cutoutGlow ? `filter: drop-shadow(0 0 18px ${spec.cutoutGlow}) drop-shadow(0 0 54px ${spec.cutoutGlow});` : ""} }
  .layer { position:absolute; inset:0; display:flex; flex-direction:column;
           padding: 52px 56px; ${zonePad[spec.zone]} }
  .textbox { position:relative; display:flex; flex-direction:column;
             align-items:flex-start; width:${boxWidth}; max-height:100%; }
  .stack { position:relative; width:100%; }
  ${spec.fillTo ? `.headline.fill { background:linear-gradient(100deg, ${spec.fill} 8%, ${spec.fillTo} 78%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }\n  .headline.fill .accent { -webkit-text-fill-color:${spec.accent}; }` : ""}
  .headline { font-family: var(--font-display); font-weight: ${font.display.weight};
              letter-spacing: var(--tracking); font-size:120px; width:100%;
              word-break:normal; overflow-wrap:normal; hyphens:none;
              text-transform: ${font.textCase === "upper" || preset.textCase === "upper" ? "uppercase" : "none"}; }
  .headline.stroke { position:absolute; inset:0; }
  .headline.fill { position:relative; }
  .eyebrow, .sub { font-family: var(--font-sans); font-weight: ${font.sans.weight}; }
  .eyebrow .accent, .sub .accent { color: var(--accent); }
  .eyebrow { text-transform: uppercase; }
  ${preset.css}
  ${overlay?.css ?? ""}
</style></head><body>
  <img class="plate" src="${plateUri}">
  ${spec.style === "scrim" ? `<div class="scrim" data-zone="${spec.zone}"></div>` : ""}
  ${overlay?.connectors ?? ""}
  ${overlay?.cardsBehind ?? ""}
  ${cutoutUri ? `<img class="cutout" src="${cutoutUri}">` : ""}
  ${overlay?.cards ?? ""}
  <div class="layer" data-zone="${spec.zone}">
    <div class="textbox">
      ${spec.eyebrow ? `<div class="eyebrow">${markup(spec.eyebrow)}</div>` : ""}
      <div class="stack">
        ${preset.strokeRatio > 0 ? `<div class="headline stroke">${head}</div>` : ""}
        <div class="headline fill">${head}</div>
      </div>
      ${spec.sub ? `<div class="sub">${markup(spec.sub)}</div>` : ""}
    </div>
  </div>
</body></html>`;
}

export async function compose(spec: ComposeSpec): Promise<Buffer> {
  const preset = STYLES[spec.style];
  if (!preset) {
    throw new Error(
      `Unknown style "${spec.style}". Options: ${Object.keys(STYLES).join(", ")}`,
    );
  }

  const font = resolvePairing(spec.type);
  const uri = `data:${spec.plate.mediaType};base64,${Buffer.from(spec.plate.bytes).toString("base64")}`;
  const overlay = spec.overlay
    ? await renderOverlay(spec.overlay, WIDTH, HEIGHT)
    : null;
  const cutoutUri = spec.cutout
    ? `data:${spec.cutout.mediaType};base64,${Buffer.from(spec.cutout.bytes).toString("base64")}`
    : null;
  const ctx = await (await getBrowser()).newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  const p = await ctx.newPage();

  try {
    await p.setContent(page(spec, preset, font, uri, cutoutUri, overlay), { waitUntil: "load" });

    // Reject silent fallback before accepting output: if the requested family
    // did not resolve from its bundled bytes, fail naming it (no default-sans
    // substitution ever reaches a screenshot).
    const unresolved: string[] = [];
    for (const face of [font.display, font.sans]) {
      if (!(await p.evaluate(familyResolved, face.family))) unresolved.push(face.family);
    }
    if (unresolved.length) {
      throw new Error(
        `Font(s) failed to resolve from bundled bytes: ${unresolved.join(", ")}. ` +
          `Silent fallback is not allowed — check assets/fonts/.`,
      );
    }

    // Shrink the headline until it fits its box. This is what makes a 4-word
    // and a 12-word variant both land without hand-tuning.
    await p.evaluate(
      ({ ratio, maxH }) => {
        const box = document.querySelector<HTMLElement>(".textbox")!;
        const stack = document.querySelector<HTMLElement>(".stack")!;
        const heads = [...document.querySelectorAll<HTMLElement>(".headline")];
        const root = document.documentElement;

        let lo = 28;
        let hi = 168;
        let best = lo;
        for (let i = 0; i < 22; i++) {
          const mid = (lo + hi) / 2;
          heads.forEach((h) => (h.style.fontSize = `${mid}px`));
          if (ratio > 0) root.style.setProperty("--stroke-w", `${mid * ratio}px`);
          const fits =
            stack.scrollWidth <= box.clientWidth + 1 &&
            box.scrollHeight <= maxH;
          if (fits) {
            best = mid;
            lo = mid;
          } else {
            hi = mid;
          }
        }
        heads.forEach((h) => (h.style.fontSize = `${best}px`));
        if (ratio > 0) root.style.setProperty("--stroke-w", `${best * ratio}px`);
      },
      {
        ratio: preset.strokeRatio * font.strokeScale,
        maxH: Math.round(HEIGHT * preset.maxHeightRatio),
      },
    );

    return await p.screenshot({ type: "png" });
  } finally {
    await ctx.close();
  }
}
