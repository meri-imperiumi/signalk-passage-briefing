/**
 * Raster conversion for synoptic charts (work doc #11). The BoM
 * difacs charts arrive as GIF and are cached as-is — browsers render
 * GIF natively. TIFF inputs (NOAA TGFTP) are decoded with the
 * vendored pure-JS UTIF decoder and re-encoded as compact 8-bit
 * grayscale PNGs using only node:zlib — no native image dependency.
 *
 * @file raster-convert.js
 */

const zlib = require("node:zlib");

/** TIFF magic: little-endian II* or big-endian MM*. */
const TIF_MAGICS = [
  Buffer.from([0x49, 0x49, 0x2a, 0x00]),
  Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46]); // "GIF"

/**
 * Detects the image format from magic bytes.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {"tif"|"png"|"gif"|"unknown"}
 */
function detectFormat(bytes) {
  const head = bytes.subarray(0, 4);
  if (head.compare(TIF_MAGICS[0]) === 0 || head.compare(TIF_MAGICS[1]) === 0) {
    return "tif";
  }
  if (head.compare(PNG_MAGIC) === 0) {
    return "png";
  }
  if (bytes.subarray(0, 3).compare(GIF_MAGIC) === 0) {
    return "gif";
  }
  return "unknown";
}

/** CRC32 for PNG chunks (polynomial 0xedb88320). */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encodes 8-bit grayscale pixels as a PNG. Each scanline is prefixed
 * with filter type 0 (none) — adequate for line art after deflate.
 *
 * @param {Uint8Array} gray - width*height luminance bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodeGrayPng(gray, width, height) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = gray[y * width + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ITU-R BT.601 luma. */
function luma(r, g, b) {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** Grayscale of an RGBA buffer. */
function rgbaToGray(rgba, pixelCount) {
  const gray = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    gray[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return gray;
}

/** GIF logical screen size: little-endian u16 at bytes 6 and 8. */
function gifSize(bytes) {
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
  };
}

/** PNG IHDR size: big-endian u32 at bytes 16 and 20. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Prepares chart bytes for the briefing. TIFF inputs are decoded and
 * re-encoded as grayscale PNG; GIF and PNG inputs pass through
 * unchanged (browsers render them natively); other formats yield
 * null.
 *
 * @param {Buffer} bytes - Source image bytes
 * @returns {{bytes: Buffer, format: "gif"|"png", width: number|null, height: number|null, converted: boolean}|null}
 */
function convertChart(bytes) {
  const format = detectFormat(bytes);
  if (format === "gif") {
    const { width, height } = gifSize(bytes);
    return { bytes, format, width, height, converted: false };
  }
  if (format === "png") {
    const { width, height } = pngSize(bytes);
    return { bytes, format, width, height, converted: false };
  }
  if (format !== "tif") {
    return null;
  }
  const UTIF = require("../public/vendor/utif/UTIF.js");
  const ifds = UTIF.decode(bytes);
  UTIF.decodeImage(bytes, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const width = ifds[0].width;
  const height = ifds[0].height;
  return {
    bytes: encodeGrayPng(rgbaToGray(rgba, width * height), width, height),
    format: "png",
    width,
    height,
    converted: true,
  };
}

module.exports = {
  detectFormat,
  encodeGrayPng,
  convertChart,
};
