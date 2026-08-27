import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanLibrary, resolveLogo, LIBRARY_ROOT, type Library, type LibraryEntry, type LogoMeta } from "./assets.js";

/**
 * A floating-card layer: rounded glass tiles with a logo and label, joined by
 * dashed connectors. Driven by a JSON file so a composition can be re-run and
 * tweaked without touching code.
 *
 * Positions are percentages of the frame, measured to the centre of the card.
 */
export interface OverlayCard {
  id: string;
  x: number;
  y: number;
  /** Card width as a percentage of frame width. */
  w: number;
  label?: string;
  /** Inline SVG file, a library logo, or literal text as the glyph. */
  mark?:
    | { type: "svg"; file: string }
    | { type: "logo"; id: string }
    | { type: "text"; text: string };
  markColor?: string;
  labelColor?: string;
  /** Strip the glass tile: text/mark floats directly on the plate. */
  bare?: boolean;
  /** Font family for a text mark, e.g. "Chalkduster". */
  font?: string;
  /** Font size for a text mark, in % of frame width (e.g. 4 ≈ 4vw). */
  textSize?: number;
  /** Turns the card into the glowing focal tile. */
  highlight?: string;
  rotate?: number;
  /** Render beneath the cutout, so the person overlaps it. */
  behind?: boolean;
}

export interface OverlayConnector {
  from: string;
  to: string;
  /** Perpendicular bow, in percent of frame width. 0 is a straight line. */
  bow?: number;
}

export interface OverlaySpec {
  cards: OverlayCard[];
  connectors?: OverlayConnector[];
  connectorColor?: string;
}

async function inlineSvg(file: string, color?: string): Promise<string> {
  let svg = await readFile(path.resolve(file), "utf8");
  svg = svg.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  svg = svg.replace(/<title>[\s\S]*?<\/title>/g, "");
  // Drop fixed pixel dimensions so the viewBox drives sizing.
  svg = svg.replace(/\s(width|height)="[^"]*"/g, "");
  if (color) {
    svg = svg.replace(/fill="(?!none)[^"]*"/g, `fill="${color}"`);
    if (!/fill=/.test(svg)) svg = svg.replace("<svg", `<svg fill="${color}"`);
  }
  return svg;
}

let library: Promise<Library> | null = null;

/** The library is scanned once per process and cached; it is small. */
export function loadLibrary(): Promise<Library> {
  library ??= scanLibrary(LIBRARY_ROOT);
  return library;
}

async function renderRaster(file: string): Promise<string> {
  const bytes = await readFile(path.resolve(file));
  const ext = path.extname(file).slice(1).toLowerCase();
  const mediaType = ext === "jpg" ? "jpeg" : ext;
  return `<img src="data:image/${mediaType};base64,${Buffer.from(bytes).toString("base64")}">`;
}

async function renderMark(card: OverlayCard): Promise<string> {
  if (!card.mark) return "";
  const color = card.markColor ?? "#FFFFFF";
  if (card.mark.type === "logo") {
    let entry: LibraryEntry<LogoMeta>;
    try {
      entry = resolveLogo(await loadLibrary(), card.mark.id);
    } catch (err) {
      throw new Error(`overlay card "${card.id}": ${(err as Error).message}`);
    }
    const markColor = card.markColor ?? entry.meta.defaultColor ?? "#FFFFFF";
    if (entry.kind === "svg") return inlineSvg(entry.imagePath, markColor);
    return renderRaster(entry.imagePath);
  }
  if (card.mark.type === "svg") return inlineSvg(card.mark.file, color);
  const style = [
    `color:${color}`,
    card.font ? `font-family:'${card.font}'` : "",
    card.textSize ? `font-size:${card.textSize}vw` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `<span class="glyph" style="${style}">${card.mark.text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")}</span>`;
}

export async function renderOverlay(
  spec: OverlaySpec,
  frameW: number,
  frameH: number,
): Promise<{ cards: string; cardsBehind: string; connectors: string; css: string }> {
  const byId = new Map(spec.cards.map((c) => [c.id, c]));
  const aspect = frameW / frameH;

  const rendered = (
    await Promise.all(
      spec.cards.map(async (c) => {
        const mark = await renderMark(c);
        const glow = c.highlight
          ? `border-color:${c.highlight}; box-shadow:0 0 0 1px ${c.highlight}55, 0 0 34px ${c.highlight}88, 0 0 90px ${c.highlight}55; background:linear-gradient(160deg, ${c.highlight}22, rgba(12,10,6,.9));`
          : "";
        return [c.behind ?? false, `<div class="ocard${c.bare ? " bare" : ""}" style="left:${c.x}%; top:${c.y}%; width:${c.w}%; ${glow} ${
          c.rotate ? `--rot:${c.rotate}deg;` : ""
        }">
          <div class="omark">${mark}</div>
          ${
            c.label
              ? `<div class="olabel" style="${c.labelColor ? `color:${c.labelColor};` : ""}">${c.label.replace(/\n/g, "<br>")}</div>`
              : ""
          }
        </div>`] as const;
      }),
    )
  );
  const cards = rendered.filter(([b]) => !b).map(([, h]) => h).join("\n");
  const cardsBehind = rendered.filter(([b]) => b).map(([, h]) => h).join("\n");

  // Connectors are drawn in a percentage viewBox so card centres line up.
  const lines = (spec.connectors ?? [])
    .map((con) => {
      const a = byId.get(con.from);
      const b = byId.get(con.to);
      if (!a || !b) return "";
      // Stop short of each card edge so the arrow reads as pointing at it.
      const dx = b.x - a.x;
      const dy = (b.y - a.y) / aspect;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const pad = (c: OverlayCard) => c.w * 0.72;
      const x1 = a.x + ux * pad(a);
      const y1 = a.y + uy * pad(a) * aspect;
      const x2 = b.x - ux * pad(b);
      const y2 = b.y - uy * pad(b) * aspect;
      const bow = con.bow ?? 0;
      const mx = (x1 + x2) / 2 - uy * bow;
      const my = (y1 + y2) / 2 + ux * bow * aspect;
      const px = (v: number) => (v / 100) * frameW;
      const py = (v: number) => (v / 100) * frameH;
      return `<path d="M ${px(x1).toFixed(1)} ${py(y1).toFixed(1)} Q ${px(mx).toFixed(1)} ${py(my).toFixed(1)} ${px(x2).toFixed(1)} ${py(y2).toFixed(1)}" marker-end="url(#arrow)"/>`;
    })
    .join("\n");

  const connectors = lines
    ? `<svg class="oconn" viewBox="0 0 ${frameW} ${frameH}">
         <defs>
           <marker id="arrow" viewBox="0 0 12 12" refX="10" refY="6"
                   markerWidth="4" markerHeight="4" orient="auto"
                   markerUnits="strokeWidth">
             <path d="M 1 1 L 11 6 L 1 11 Z" fill="${spec.connectorColor ?? "#FFFFFF"}"/>
           </marker>
         </defs>
         ${lines}
       </svg>`
    : "";

  const css = `
  .ocard { position:absolute; transform:translate(-50%,-50%) rotate(var(--rot,0deg));
           aspect-ratio:1; border-radius:19%; display:flex; flex-direction:column;
           align-items:center; justify-content:center; gap:6%;
           background:linear-gradient(160deg, rgba(28,32,40,.92), rgba(10,12,16,.94));
           border:1px solid rgba(255,255,255,.16);
           box-shadow:0 0 0 1px rgba(255,255,255,.05), 0 10px 40px rgba(0,0,0,.7),
                      inset 0 1px 0 rgba(255,255,255,.09); }
  .ocard.bare { aspect-ratio:auto; background:none; border:none; box-shadow:none; }
  .omark { width:52%; height:52%; display:flex; align-items:center; justify-content:center; }
  .omark svg { width:100%; height:100%; display:block; }
  .omark img { width:100%; height:100%; object-fit:contain; display:block; }
  .glyph { font-family:${"ui-monospace, SFMono-Regular, Menlo, monospace"}; font-weight:800;
           font-size:2.7vw; line-height:1; white-space:nowrap; }
  .olabel { font-family:var(--font-sans); font-weight:700; color:#fff; width:118%;
            font-size:1.42vw; line-height:1.15; text-align:center; letter-spacing:.01em; }
  .oconn { position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
  .oconn > path { fill:none; stroke:${spec.connectorColor ?? "#FFFFFF"}; stroke-width:3.2;
                stroke-dasharray:10 9; stroke-linecap:butt; }
  `;

  return { cards, cardsBehind, connectors, css };
}
