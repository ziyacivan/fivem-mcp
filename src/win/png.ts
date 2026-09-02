// Minimal PNG (8-bit RGB) encoder — zlib from node:core, no native image dependency.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/**
 * Encode RGB8 pixels (row-major, no alpha, length = width*height*3) as a PNG.
 * Filter byte 0 per scanline; zlib level 6 keeps GTA frames small enough for
 * vision round-trips while staying fast.
 */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  if (width <= 0 || height <= 0) throw new Error(`bad image size ${width}x${height}`);
  if (rgb.length !== width * height * 3) {
    throw new Error(`pixel buffer is ${rgb.length} bytes, expected ${width * height * 3}`);
  }
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 0;
    rgb.copy(raw, out + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering off by our choice (all filter byte 0)
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crop RGB8 pixels (row-major, no alpha) to a rectangle clamped to the image. */
export function cropRgb(
  src: Buffer,
  srcW: number,
  srcH: number,
  rect: CropRect | undefined,
): { rgb: Buffer; width: number; height: number } {
  if (!rect) return { rgb: src, width: srcW, height: srcH };
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(srcW - x, Math.round(rect.width));
  const h = Math.min(srcH - y, Math.round(rect.height));
  if (w <= 0 || h <= 0) {
    throw new Error(`crop ${JSON.stringify(rect)} lies outside the ${srcW}x${srcH} image`);
  }
  const out = Buffer.alloc(w * h * 3);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * srcW + x) * 3;
    src.copy(out, row * w * 3, from, from + w * 3);
  }
  return { rgb: out, width: w, height: h };
}

/** Downscale with bilinear sampling so screenshots stay token-cheap. */
export function downscaleRgb(
  rgb: Buffer,
  width: number,
  height: number,
  maxSide: number,
): { rgb: Buffer; width: number; height: number } {
  if (Math.max(width, height) <= maxSide) return { rgb, width, height };
  const scale = maxSide / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor((y / outH) * height));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor((x / outW) * width));
      const src = (sy * width + sx) * 3;
      const dst = (y * outW + x) * 3;
      out[dst] = rgb[src] ?? 0;
      out[dst + 1] = rgb[src + 1] ?? 0;
      out[dst + 2] = rgb[src + 2] ?? 0;
    }
  }
  return { rgb: out, width: outW, height: outH };
}
