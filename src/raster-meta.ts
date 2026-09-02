/**
 * Bounded format sniffing + trusted header metadata for the Reference
 * Thumbnail import's supported raster formats: PNG, JPEG, and WebP — exactly
 * these three. Anything else is refused with a convert-locally hint rather
 * than guessed at or handed to a decoder blind.
 *
 * The reader inspects header bytes only — never pixel data — and bounds-checks
 * every index before it reads, so a truncated or hostile header is a refusal,
 * never an out-of-bounds read and never an allocation. The geometry it returns
 * is the trusted input for the decoded-pixel budget that src/reference-import.ts
 * enforces before Chromium rasterizes anything: a highly compressed raster
 * cannot surprise the decoder with more pixels than the budget allows.
 */

export type RasterFormat = "png" | "jpeg" | "webp";

export interface RasterMeta {
  format: RasterFormat;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The one reader that decides which supported format these bytes claim to be. */
export function sniffRasterFormat(bytes: Buffer): RasterFormat | undefined {
  if (bytes.length >= 8 && PNG_SIGNATURE.equals(bytes.subarray(0, 8))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  return undefined;
}

const unsupported = (file: string): string =>
  `"${file}" is not a PNG, JPEG, or WebP image — the supported Reference Thumbnail input formats. ` +
  `Export a copy in one of those formats locally (for a raster source: ` +
  `\`sips -s format png "${file}" --out "${file}.png"\`; for vector or document formats: ` +
  `open the file in a browser and save a PNG) and import that.`;

/**
 * Trusted width/height from the format's own header — PNG's IHDR, JPEG's first
 * frame-header segment, WebP's first chunk header. Every byte index is
 * bounds-checked before it is read; a truncated or malformed header is a
 * refusal with an actionable message, never a throw past the caller and never
 * a guess. The declared geometry is exactly what the decoded-pixel budget
 * needs — chunk CRCs and pixel data are the decoder's job, not this gate's.
 */
export function readRasterMeta(bytes: Buffer, file: string): RasterMeta | string {
  const format = sniffRasterFormat(bytes);
  if (!format) return unsupported(file);

  if (format === "png") {
    // IHDR is always the first chunk: signature (8) + length/type (8) + 13
    // bytes of IHDR data — width at 16, height at 20.
    if (bytes.length < 24)
      return `"${file}" ends inside the PNG header — truncated, not a real PNG file`;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width === 0 || height === 0)
      return `"${file}" declares a ${width}×${height} PNG canvas — not a real image`;
    return { format, width, height };
  }

  if (format === "jpeg") {
    // Walk the segment chain from just past the SOI the sniff verified; every
    // segment is length-prefixed, so the walk is bounded by the buffer. The
    // first frame-header segment (SOF0–SOF15, minus the non-frame markers
    // DHT/JPG/DAC) carries the coded dimensions.
    let off = 2;
    for (;;) {
      if (off + 2 > bytes.length)
        return `"${file}" has no JPEG frame header — truncated, not a real JPEG file`;
      if (bytes[off] !== 0xff)
        return `"${file}" has an unreadable JPEG structure at byte ${off} — not a real JPEG file`;
      const marker = bytes[off + 1]!;
      if (marker === 0xff) {
        off += 1; // fill byte before a marker
        continue;
      }
      const standalone = (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xd8;
      if (standalone) {
        off += 2;
        continue;
      }
      if (off + 4 > bytes.length)
        return `"${file}" has a truncated JPEG segment header — not a real JPEG file`;
      const segLen = bytes.readUInt16BE(off + 2)!;
      if (segLen < 2)
        return `"${file}" has an invalid JPEG segment length (${segLen}) — not a real JPEG file`;
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrameHeader) {
        if (off + 9 > bytes.length)
          return `"${file}" ends inside its JPEG frame header — truncated, not a real JPEG file`;
        const height = bytes.readUInt16BE(off + 5)!;
        const width = bytes.readUInt16BE(off + 7)!;
        if (width === 0 || height === 0)
          return `"${file}" declares a ${width}×${height} JPEG frame — not a real image`;
        return { format, width, height };
      }
      off += 2 + segLen;
    }
  }

  // WebP: RIFF + WEBP verified by the sniff; the first chunk header names the
  // layout and carries the canvas geometry.
  if (bytes.length < 20)
    return `"${file}" has a truncated WebP header — not a real WebP file`;
  const fourcc = bytes.toString("latin1", 12, 16);
  if (fourcc === "VP8 ") {
    // Lossy keyframe: 3-byte frame tag, 3-byte start code (9d 01 2a), then
    // 14-bit width and height.
    if (bytes.length < 30)
      return `"${file}" has a truncated WebP VP8 header — not a real WebP file`;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
      return `"${file}" has an unreadable WebP VP8 frame header — not a real WebP file`;
    const width = bytes.readUInt16LE(26)! & 0x3fff;
    const height = bytes.readUInt16LE(28)! & 0x3fff;
    if (width === 0 || height === 0)
      return `"${file}" declares a ${width}×${height} WebP frame — not a real image`;
    return { format: "webp", width, height };
  }
  if (fourcc === "VP8L") {
    // Lossless: signature byte 0x2f, then a 32-bit little-endian word packing
    // width−1 into bits 0–13 and height−1 into bits 14–27.
    if (bytes.length < 25)
      return `"${file}" has a truncated WebP lossless header — not a real WebP file`;
    if (bytes[20] !== 0x2f)
      return `"${file}" has an unreadable WebP lossless header — not a real WebP file`;
    const word = bytes.readUInt32LE(21);
    return {
      format: "webp",
      width: (word & 0x3fff) + 1,
      height: ((word >>> 14) & 0x3fff) + 1,
    };
  }
  if (fourcc === "VP8X") {
    // Extended: payload starts at byte 20 with a 1-byte flag field, then 3
    // reserved bytes, then 24-bit canvas width−1 (24) and height−1 (27).
    if (bytes.length < 30)
      return `"${file}" has a truncated WebP extended header — not a real WebP file`;
    const width = bytes.readUIntLE(24, 3) + 1;
    const height = bytes.readUIntLE(27, 3) + 1;
    if (width === 0 || height === 0)
      return `"${file}" declares a ${width}×${height} WebP canvas — not a real image`;
    return { format: "webp", width, height };
  }
  return `"${file}" uses a WebP chunk layout this tool cannot read — not a supported WebP file`;
}