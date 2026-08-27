#!/usr/bin/env bun
// Keys a flat chroma background out of an image, writing a transparent PNG.
// Usage: bun run src/chromakey.ts <in.png> <out.png> [hex]
// Drives the same headless Chromium the compositor uses, so no image library
// is added: the pixel pass runs on a canvas inside the browser.

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";

const [input, output, hex = "#00FF00"] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: bun run src/chromakey.ts <in.png> <out.png> [keyHex]");
  process.exit(1);
}

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

// Distance in RGB space below which a pixel is pure background; above the
// soft band it keeps full opacity. Between the two, partial alpha plus
// background suppression keeps edge pixels (hair) from fringing green.
const HARD = 95;
const SOFT = 170;

const bytes = await readFile(input);
const dataUrl = `data:image/${input.endsWith(".jpg") ? "jpeg" : "png"};base64,${bytes.toString("base64")}`;
const [kr, kg, kb] = hexToRgb(hex);

const browser = await chromium.launch();
try {
  const pngData = await browser.newPage().then(async (page) => {
    await page.goto("about:blank");
    return page.evaluate(
      async ({ dataUrl, kr, kg, kb, HARD, SOFT }) => {
        const img = new Image();
        await new Promise<void>((ok, bad) => {
          img.onload = () => ok();
          img.onerror = () => bad(new Error("image failed to load"));
          img.src = dataUrl;
        });
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          const dist = Math.hypot(p[i]! - kr, p[i + 1]! - kg, p[i + 2]! - kb);
          if (dist <= HARD) {
            p[i + 3] = 0;
          } else if (dist < SOFT) {
            const t = (dist - HARD) / (SOFT - HARD);
            p[i + 3] = Math.round(255 * t);
            // Un-mix the background colour from the semi-transparent pixel.
            const a = 1 - t;
            p[i] = Math.max(0, Math.min(255, Math.round((p[i]! - kr * a) / t)));
            p[i + 1] = Math.max(0, Math.min(255, Math.round((p[i + 1]! - kg * a) / t)));
            p[i + 2] = Math.max(0, Math.min(255, Math.round((p[i + 2]! - kb * a) / t)));
          }
        }
        ctx.putImageData(d, 0, 0);
        // Trim transparent margins so the subject hugs wherever the compositor
        // anchors the image — a full-frame canvas would centre the subject.
        const p2 = d.data;
        let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            if (p2[(y * c.width + x) * 4 + 3]! > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX <= minX || maxY <= minY) return c.toDataURL("image/png");
        const t = document.createElement("canvas");
        t.width = maxX - minX + 1;
        t.height = maxY - minY + 1;
        t.getContext("2d")!.drawImage(c, minX, minY, t.width, t.height, 0, 0, t.width, t.height);
        return t.toDataURL("image/png");
      },
      { dataUrl, kr, kg, kb, HARD, SOFT },
    );
  });
  await writeFile(output, Buffer.from(pngData.split(",")[1]!, "base64"));
  console.log(`  keyed    ${input} → ${output}`);
} finally {
  await browser.close();
}
