/**
 * The legacy `thumb --ref` normalization at the true public CLI boundary
 * (INT-1, #56 review): a bare `--ref <path>` must reach the provider as a
 * typed identity reference — role-assigned in the effective prompt, with no
 * machine-local path in model-facing prose and the exact file bytes attached.
 *
 * The legacy script has no in-process seams (see cli-approval.test.ts), so
 * the subprocess is the honest seam — and the provider edge is mocked through
 * a `bun --preload` module so the run exercises the real argument parsing and
 * normalization code with zero spend: the mock captures what the model would
 * have received and then refuses, so no image is ever generated, no browser
 * starts, and no candidate is written. The preload must live under the repo's
 * gitignored node_modules so its mock.module patches the same module instance
 * the CLI's import graph resolves (a preload outside the repo resolves a
 * different auto-installed instance and the patch does not apply).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

let root: string;
let project: string;
let capturePath: string;
let refPath: string;
let refBytes: Buffer;
let preloadPath: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "thumby-legacy-ref-"));
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  refPath = path.join(project, "kenny-likeness.png");
  refBytes = Buffer.from("likeness-reference-bytes");
  await writeFile(refPath, refBytes);
  // The provider-edge mock: capture the exact request, then refuse — proving
  // the run reached the model boundary without spending anything. Written
  // under the gitignored out/ so "ai" resolves — by walking up to the shared
  // node_modules — to the same instance the CLI's import graph uses
  // (pid-suffixed; removed in afterAll).
  preloadPath = path.join(REPO_ROOT, "out", `.thumby-mock-ai-${process.pid}.ts`);
  await mkdir(path.dirname(preloadPath), { recursive: true });
  await writeFile(
    preloadPath,
    `import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
mock.module("ai", () => ({
  generateImage: async (opts) => {
    // Byte arrays do not survive JSON — capture reference bytes as base64.
    const record = opts && typeof opts === "object" && typeof opts.prompt === "object"
      ? { ...opts, prompt: { ...opts.prompt, images: (opts.prompt.images ?? []).map((b) => Buffer.from(b).toString("base64")) } }
      : opts;
    appendFileSync(process.env.THUMBY_AI_CAPTURE, JSON.stringify(record) + "\\n");
    throw new Error("mock: provider edge reached, no spend");
  },
  generateText: async () => {
    throw new Error("mock: generateText must not be called by the default plate path");
  },
}));
`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(preloadPath, { force: true });
});

/** One captured provider call: { prompt: string | { text, images: base64[] } }. */
async function capturedCalls(): Promise<{ prompt: string | { text: string; images: string[] } }[]> {
  const raw = await readFile(capturePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a bare legacy --ref reaches the provider identity-typed, role-assigned, and path-free", async () => {
  capturePath = path.join(root, "capture.jsonl");
  const proc = Bun.spawn(
    ["bun", "--preload", preloadPath, CLI, "--prompt", "a calm studio backdrop", "--headline", "Setup", "--ref", refPath],
    {
      cwd: project,
      // A dummy key passes the CLI's pre-flight check; the provider module is
      // mocked by the preload, so no real call is ever made (zero spend).
      env: { ...process.env, THUMBY_AI_CAPTURE: capturePath, AI_GATEWAY_API_KEY: "test-dummy-key" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  // The failure is the mock's provider-edge refusal — proving the run passed
  // argument parsing, the reference-capability gate, and reference loading,
  // and that generation (the only billed step) was attempted and never spent.
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/mock: provider edge reached/);

  const calls = await capturedCalls();
  expect(calls).toHaveLength(1);
  const prompt = calls[0]!.prompt;
  expect(typeof prompt).toBe("object"); // references present: { text, images } shape
  const { text, images } = prompt as { text: string; images: string[] };

  // The bare path was normalized to the identity role and role-assigned in
  // the effective prompt (INT-1)…
  expect(text).toMatch(/image 1 — identity/);
  // …with no machine-local path in model-facing prose…
  expect(text).not.toContain(refPath);
  expect(text).not.toContain(path.basename(refPath));
  // …and the exact reference bytes attached (captured base64-decoded).
  expect(images).toHaveLength(1);
  expect(sha256(Buffer.from(images[0]!, "base64"))).toBe(sha256(refBytes));
  // The legacy non-subjectless contract is otherwise unchanged.
  expect(text).toMatch(/no text/i);
  expect(text).not.toMatch(/backdrop only/i);
});