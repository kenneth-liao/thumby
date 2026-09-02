/**
 * Shared helpers for the browser-backed Scene author suites: the CLI fixture
 * bundle, the subprocess stdout event pump, and raw loopback HTTP with exact
 * header control. One home — the suites must never grow a second copy of
 * these facts.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { encodePngRgba } from "../src/png.js";

/** The repo root and the Scene CLI entrypoint the suites spawn. */
export const ROOT = path.resolve(import.meta.dir, "..");
export const CLI = path.join(ROOT, "src/scene-cli.ts");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#10233f"/></svg>`;
/** Intrinsic 200×200 source for live fixtures' cropped/image layers. */
export const PHOTO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#3366aa"/><circle cx="100" cy="100" r="70" fill="#ffcc00"/></svg>`;

/** Left half red, right half blue — a valid 1280×720 reference with spatial variation. */
export const halfReferenceRgba = (): Buffer => {
  const rgba = Buffer.alloc(1280 * 720 * 4);
  for (let y = 0; y < 720; y++)
    for (let x = 0; x < 1280; x++) {
      const i = (y * 1280 + x) * 4;
      rgba[i] = x < 640 ? 255 : 0;
      rgba[i + 2] = x < 640 ? 0 : 255;
      rgba[i + 3] = 255;
    }
  return rgba;
};

export interface Fixture {
  root: string;
  scenePath: string;
  referencePath: string;
}

/** A minimal valid Scene bundle: project-local SVG layer + a 1280×720 reference. */
export async function makeFixture(
  name: string,
  override?: (scene: Record<string, unknown>) => Record<string, unknown>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `thumby-author-${name}-`));
  await writeFile(path.join(root, "bg.svg"), SVG);
  await writeFile(path.join(root, "photo.svg"), PHOTO_SVG);
  const referencePath = path.join(root, "ref.png");
  await writeFile(referencePath, encodePngRgba(1280, 720, halfReferenceRgba()));
  const scene: Record<string, unknown> = {
    schemaVersion: 1,
    canvas: { width: 1280, height: 720 },
    layers: [
      {
        id: "bg",
        type: "image",
        asset: "./bg.svg",
        position: { x: 0, y: 0 },
        size: { width: 1280, height: 720 },
      },
    ],
    reference: { path: "./ref.png" },
  };
  const scenePath = path.join(root, "scene.json");
  await writeFile(scenePath, JSON.stringify(override ? override(scene) : scene));
  return { root, scenePath, referencePath };
}

export type JsonEvent = Record<string, unknown> & { event?: string };

/**
 * Pumps the session's stdout in the background, collecting one-line JSON
 * events as they arrive; waiters resolve on the matching event.
 */
export class SessionEvents {
  readonly events: JsonEvent[] = [];
  readonly #proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly #waiters: {
    test: (e: JsonEvent) => boolean;
    resolve: (e: JsonEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(proc: Bun.Subprocess<"ignore", "pipe", "pipe">) {
    this.#proc = proc;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    const reader = this.#proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        this.#line(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) this.#line(buf.trim());
  }

  #line(line: string): void {
    if (!line) return;
    let evt: JsonEvent;
    try {
      evt = JSON.parse(line) as JsonEvent;
    } catch {
      return;
    }
    this.events.push(evt);
    for (const w of this.#waiters.splice(0)) {
      if (w.test(evt)) {
        clearTimeout(w.timer);
        w.resolve(evt);
      } else {
        this.#waiters.push(w);
      }
    }
  }

  waitForEvent(name: string, timeoutMs = 30_000): Promise<JsonEvent> {
    const seen = this.events.find((e) => e.event === name);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no "${name}" event within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.#waiters.push({ test: (e) => e.event === name, resolve, timer });
    });
  }
}

/** HTTP request with exact Host-header control (the session's auth surface). */
export function rawRequest(
  port: number,
  reqPath: string,
  opts: { method?: string; host?: string } = {},
): Promise<{
  status: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: opts.method ?? "GET",
        headers: opts.host === undefined ? {} : { Host: opts.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}