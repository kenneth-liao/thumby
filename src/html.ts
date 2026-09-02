/**
 * The one home for HTML-escaping, file-URL conversion, and embedded-evidence
 * data URLs — every generated HTML document (creator review sheets,
 * reference-compare sheets) interpolates untrusted strings and local paths or
 * verified bytes into an executable-document boundary, and must go through
 * these helpers rather than growing a second escaping or embedding home.
 */

import { pathToFileURL } from "node:url";

/** Escape a string for safe interpolation into HTML text or attribute context. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Convert a local absolute path to a percent-encoded file:// URL for an img src. */
export function fileUrl(p: string): string {
  return pathToFileURL(p).href;
}

/**
 * Sniff the image MIME from magic bytes. Embedded evidence declares its own
 * type — a wrong declared type would be its own false label, and recorded
 * media types and file extensions are not authoritative for bytes that cross
 * a trust boundary.
 */
export function imageMime(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

/**
 * One data-URL home for embedded evidence: the exact verified bytes, base64 —
 * a review sheet built from these cannot drift from what was verified, and
 * stays intact no matter what later happens to the source files.
 */
export function dataUrl(bytes: Uint8Array, mime: string = imageMime(bytes)): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
