/**
 * The one home for HTML-escaping and file-URL conversion — every generated
 * HTML document (creator review sheets, reference-compare sheets) interpolates
 * untrusted strings and local paths into an executable-document boundary, and
 * must go through these helpers rather than growing a second escaping home.
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
