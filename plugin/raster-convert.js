/**
 * Raster conversion for synoptic charts (work doc #11): decodes the
 * agencies' TIFF charts with the vendored pure-JS UTIF decoder and
 * re-encodes them as compact 8-bit grayscale PNGs using only
 * node:zlib — no native image dependency. Radiofax charts are
 * near-bilevel line art, so grayscale PNG deflates well below the
 * ~100 KB target.
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

/**
 * Detects the image format from magic bytes.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {"tif"|"png"|"unknown"}
 */
function detectFormat(bytes) {
  const head = bytes.subarray(0, 4);
  if (head.compare(TIF_MAGICS[0]) === 0 || head.compare(TIF_MAGICS[1]) === 0) {
    return "tif";
  }
  if (head.compare(PNG_MAGIC) === 0) {
    return "png";
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

/**
 * Converts chart bytes to a grayscale PNG. TIFF inputs are decoded
 * with the vendored UTIF; PNG input passes through unchanged; other
 * formats (GIF sources) are not supported and yield null.
 *
 * @param {Buffer} bytes - Source image bytes
 * @returns {{png: Buffer, width: number, height: number, converted: boolean}|null}
 */
function convertToPng(bytes) {
  const format = detectFormat(bytes);
  if (format === "png") {
    return { png: bytes, width: 0, height: 0, converted: false };
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
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return {
    png: encodeGrayPng(gray, width, height),
    width,
    height,
    converted: true,
  };
}

module.exports = {
  detectFormat,
  encodeGrayPng,
  convertToPng,
};
