// Minimal PNG (8-bit RGB) encoder — zlib from node:core, no native image dependency —
// plus the crop/downscale step that turns a captured BGRA frame into a small RGB image.

import { deflate as deflateCallback, deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC-32: feed the chunk type then the data, no concatenation needed. */
function crc32Update(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return c;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  const crc = crc32Update(crc32Update(0xffffffff, typeBytes), data);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** zlib level 4: GTA frames are noisy, level 6 buys ~5% size for ~30% more time. */
const DEFLATE_LEVEL = 4;

function scanlines(width: number, height: number, rgb: Buffer): Buffer {
  if (width <= 0 || height <= 0) throw new Error(`bad image size ${width}x${height}`);
  if (rgb.length !== width * height * 3) {
    throw new Error(`pixel buffer is ${rgb.length} bytes, expected ${width * height * 3}`);
  }
  const stride = width * 3;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    raw[out] = 0; // filter type 0 (None) per scanline
    rgb.copy(raw, out + 1, y * stride, (y + 1) * stride);
  }
  return raw;
}

function assemble(width: number, height: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering off by our choice (all filter byte 0)
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Encode RGB8 pixels (row-major, no alpha, length = width*height*3) as a PNG. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  return assemble(
    width,
    height,
    deflateSync(scanlines(width, height, rgb), { level: DEFLATE_LEVEL }),
  );
}

/** Same as encodePng but compresses off the event loop (zlib threadpool). */
export function encodePngAsync(width: number, height: number, rgb: Buffer): Promise<Buffer> {
  const raw = scanlines(width, height, rgb);
  return new Promise((resolve, reject) => {
    deflateCallback(raw, { level: DEFLATE_LEVEL }, (error, idat) => {
      if (error) reject(error);
      else resolve(assemble(width, height, idat));
    });
  });
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clamp a crop request to the image; throws when nothing of it lies inside. */
function clampCrop(srcW: number, srcH: number, rect: CropRect | undefined): CropRect {
  if (!rect) return { x: 0, y: 0, width: srcW, height: srcH };
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.min(srcW - x, Math.round(rect.width));
  const height = Math.min(srcH - y, Math.round(rect.height));
  if (width <= 0 || height <= 0) {
    throw new Error(`crop ${JSON.stringify(rect)} lies outside the ${srcW}x${srcH} image`);
  }
  return { x, y, width, height };
}

/** Output size for a `maxSide` downscale of `width`x`height` (never upscales). */
function fitTo(width: number, height: number, maxSide: number): { width: number; height: number } {
  if (Math.max(width, height) <= maxSide) return { width, height };
  const scale = maxSide / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface RenderedFrame {
  rgb: Buffer;
  width: number;
  height: number;
}

/**
 * Screenshot pipeline in one pass: read the crop window straight out of the
 * BGRA capture, box-average every output pixel over its source footprint, and
 * emit RGB. Only the ~maxSide² output pixels are ever converted, so a 1080p
 * frame costs a fraction of converting, copying and then sampling the full
 * image. Box filtering (area average) keeps HUD text legible, which
 * nearest-neighbour sampling did not.
 */
export function renderFrame(
  bgra: Buffer,
  srcW: number,
  srcH: number,
  options: { crop?: CropRect | undefined; maxSide: number },
): RenderedFrame {
  if (bgra.length !== srcW * srcH * 4) {
    throw new Error(`BGRA buffer is ${bgra.length} bytes, expected ${srcW * srcH * 4}`);
  }
  const crop = clampCrop(srcW, srcH, options.crop);
  const { width: outW, height: outH } = fitTo(crop.width, crop.height, options.maxSide);
  const out = Buffer.allocUnsafe(outW * outH * 3);

  // Source column ranges per output column, computed once.
  const colStart = new Int32Array(outW + 1);
  for (let x = 0; x <= outW; x++) colStart[x] = crop.x + Math.floor((x * crop.width) / outW);

  let dst = 0;
  for (let y = 0; y < outH; y++) {
    const rowStart = crop.y + Math.floor((y * crop.height) / outH);
    const rowEnd = crop.y + Math.floor(((y + 1) * crop.height) / outH);
    for (let x = 0; x < outW; x++) {
      const c0 = colStart[x] as number;
      const c1 = colStart[x + 1] as number;
      let b = 0;
      let g = 0;
      let r = 0;
      for (let sy = rowStart; sy < rowEnd; sy++) {
        let i = (sy * srcW + c0) * 4;
        for (let sx = c0; sx < c1; sx++, i += 4) {
          b += bgra[i] as number;
          g += bgra[i + 1] as number;
          r += bgra[i + 2] as number;
        }
      }
      const n = (rowEnd - rowStart) * (c1 - c0);
      out[dst++] = (r / n + 0.5) | 0;
      out[dst++] = (g / n + 0.5) | 0;
      out[dst++] = (b / n + 0.5) | 0;
    }
  }
  return { rgb: out, width: outW, height: outH };
}

/** Crop RGB8 pixels (row-major, no alpha) to a rectangle clamped to the image. */
export function cropRgb(
  src: Buffer,
  srcW: number,
  srcH: number,
  rect: CropRect | undefined,
): { rgb: Buffer; width: number; height: number } {
  if (!rect) return { rgb: src, width: srcW, height: srcH };
  const { x, y, width: w, height: h } = clampCrop(srcW, srcH, rect);
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * srcW + x) * 3;
    src.copy(out, row * w * 3, from, from + w * 3);
  }
  return { rgb: out, width: w, height: h };
}

/** Nearest-neighbour downscale of RGB8 pixels (kept for the live scripts; see renderFrame). */
export function downscaleRgb(
  rgb: Buffer,
  width: number,
  height: number,
  maxSide: number,
): { rgb: Buffer; width: number; height: number } {
  const { width: outW, height: outH } = fitTo(width, height, maxSide);
  if (outW === width && outH === height) return { rgb, width, height };
  const out = Buffer.allocUnsafe(outW * outH * 3);
  const sxs = new Int32Array(outW);
  for (let x = 0; x < outW; x++) sxs[x] = Math.min(width - 1, Math.floor((x / outW) * width));
  let dst = 0;
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor((y / outH) * height));
    const rowBase = sy * width;
    for (let x = 0; x < outW; x++) {
      const src = (rowBase + (sxs[x] as number)) * 3;
      out[dst++] = rgb[src] as number;
      out[dst++] = rgb[src + 1] as number;
      out[dst++] = rgb[src + 2] as number;
    }
  }
  return { rgb: out, width: outW, height: outH };
}
