/**
 * The Creator approval gate on the legacy `thumb --cutout` path (REQ-018, #40).
 *
 * The gate shipped Scene-scoped (#39); the legacy command could still take a
 * trial Creator Asset to a final-looking PNG. These tests run the real CLI as
 * a subprocess against a fixture library (via the THUMBY_LIBRARY_ROOT env
 * override — the script has no in-process seams), asserting the three
 * behaviors the Scene gate already guarantees: trial rendering rejects with
 * both remedies, the explicit override renders clearly marked non-final, and
 * approved Assets render unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./png.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const CUTOUT_PNG = encodePng(8, 8, () => [200, 10, 10, 255]);
const BG_PNG = encodePng(320, 180, () => [20, 20, 30, 255]);

let root: string;
let libRoot: string;
let project: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-cli-approval-"));
  libRoot = path.join(root, "library");
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "bg.png"), BG_PNG);
  const writeCutout = async (id: string, approval: "trial" | "approved") => {
    const dir = path.join(libRoot, "cutouts", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cutout.png"), CUTOUT_PNG);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        kind: "cutout",
        id,
        name: id,
        tags: [],
        approval,
        ...(approval === "approved" ? { source: "https://example.test/kit" } : {}),
      }),
    );
  };
  await writeCutout("kenny-trial", "trial");
  await writeCutout("kenny-approved", "approved");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The legacy script has no run() seam — the subprocess is the honest seam.
 * THUMBY_LIBRARY_ROOT points the resolution contract at the fixture library;
 * cwd is the fixture project so out/, run.json, and history.jsonl land there.
 */
async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: project,
    env: { ...process.env, THUMBY_LIBRARY_ROOT: libRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("legacy thumb --cutout approval gate (#40)", () => {
  it(
    "refuses a trial Creator Asset, naming the asset and both remedies",
    async () => {
      const { exitCode, stdout, stderr } = await runCli([
        "--bg", "bg.png",
        "--headline", "Hi",
        "--cutout", "kenny-trial",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/kenny-trial/);
      expect(stderr).toMatch(/library approve/);
      expect(stderr).toMatch(/--experimental/);
      // Refusal happens before anything is written — no output directory.
      await expect(readdir(path.join(project, "out"))).rejects.toThrow();
      expect(stdout).not.toMatch(/output/);
    },
  );

  it(
    "the experimental override renders while clearly marking the output non-final",
    async () => {
      const { exitCode, stdout } = await runCli([
        "--bg", "bg.png",
        "--headline", "Hi",
        "--cutout", "kenny-trial",
        "--experimental",
      ]);
      expect(exitCode).toBe(0);
      // Clearly marked: the .trial output-name hint and the NON-FINAL warning.
      expect(stdout).toMatch(/hi\.trial\.png/);
      expect(stdout).toMatch(/NON-FINAL/);
      expect(stdout).toMatch(/kenny-trial/);
      const record = JSON.parse(
        await readFile(path.join(project, "out", "run.json"), "utf8"),
      ) as { outputs: string[]; warnings: string[] };
      expect(record.outputs).toContain("hi.trial.png");
      expect(record.warnings.join(" ")).toMatch(/NON-FINAL/);
      expect(record.warnings.join(" ")).toMatch(/kenny-trial/);
    },
    60000,
  );

  it(
    "renders an approved Creator Asset unchanged — no .trial name, no NON-FINAL warning",
    async () => {
      const { exitCode, stdout } = await runCli([
        "--bg", "bg.png",
        "--headline", "Hi",
        "--cutout", "kenny-approved",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/hi\.png/);
      expect(stdout).not.toMatch(/NON-FINAL/);
      const record = JSON.parse(
        await readFile(path.join(project, "out", "run.json"), "utf8"),
      ) as { outputs: string[]; warnings: string[] };
      expect(record.outputs).toContain("hi.png");
      expect(record.outputs.join(" ")).not.toMatch(/\.trial\.png/);
      expect(record.warnings.join(" ")).not.toMatch(/NON-FINAL/);
    },
    60000,
  );
});
