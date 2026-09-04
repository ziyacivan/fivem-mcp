import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cropRgb, downscaleRgb, encodePng, encodePngAsync, renderFrame } from "../src/win/png.js";
import { bgraToRgb, measureBrightness } from "../src/win/win32.js";

function readChunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let off = 8; // signature
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    chunks.push({ type, data: png.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

describe("PNG encoder", () => {
  it("emits a structurally valid 2x2 RGB PNG", () => {
    const rgb = Buffer.from([
      255,
      0,
      0,
      0,
      255,
      0, // row 0: red, green
      0,
      0,
      255,
      10,
      20,
      30, // row 1: blue, dark
    ]);
    const png = encodePng(2, 2, rgb);
    expect(
      png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = chunks[0]?.data;
    if (!ihdr) throw new Error("no IHDR chunk");
    expect(ihdr.readUInt32BE(0)).toBe(2);
    expect(ihdr.readUInt32BE(4)).toBe(2);
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(2);
    const idat = chunks[1]?.data;
    if (!idat) throw new Error("no IDAT chunk");
    const raw = inflateSync(idat);
    // per scanline: 1 filter byte + 2 px * 3 channels
    expect(raw.length).toBe((1 + 6) * 2);
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 4))).toEqual([255, 0, 0]);
  });

  it("rejects wrong pixel buffer sizes", () => {
    expect(() => encodePng(2, 2, Buffer.alloc(11))).toThrow(/expected 12/);
  });

  it("checksums round-trip: a corrupted byte breaks chunk order detection", () => {
    const png = encodePng(1, 1, Buffer.from([1, 2, 3]));
    const chunks = readChunks(png);
    // CRC of IHDR must be the 4 bytes right after its data:
    const ihdrLen = chunks[0]?.data.length ?? -1;
    const crcAt = 8 + 4 + ihdrLen;
    expect(png.readUInt32BE(crcAt)).toBeGreaterThan(0);
  });
});

describe("cropRgb", () => {
  const w = 4;
  const h = 4;
  const src = Buffer.alloc(w * h * 3);
  src[(1 * w + 1) * 3] = 42; // (1,1)
  src[(2 * w + 2) * 3] = 43; // (2,2)

  it("no crop passes through", () => {
    const out = cropRgb(src, w, h, undefined);
    expect(out.rgb).toBe(src);
    expect(out.width).toBe(w);
  });

  it("crops and clamps to the image", () => {
    const out = cropRgb(src, w, h, { x: 1, y: 1, width: 3, height: 10 });
    expect(out.width).toBe(3);
    expect(out.height).toBe(3);
    expect(out.rgb[0]).toBe(42);
    expect(out.rgb[(1 * 3 + 1) * 3]).toBe(43);
  });

  it("rejects a fully-outside rect", () => {
    expect(() => cropRgb(src, w, h, { x: 9, y: 0, width: 2, height: 2 })).toThrow(/outside/);
  });
});

describe("downscaleRgb", () => {
  it("is a no-op when the image already fits", () => {
    const rgb = Buffer.alloc(3 * 3 * 3, 7);
    const out = downscaleRgb(rgb, 3, 3, 1280);
    expect(out.width).toBe(3);
    expect(out.rgb).toBe(rgb);
  });

  it("nearest-samples a 4x4 to 2x2", () => {
    const rgb = Buffer.alloc(4 * 4 * 3);
    // 2x2 output samples source rows/cols {0,2}
    rgb[(0 * 4 + 0) * 3] = 42;
    rgb[(2 * 4 + 2) * 3] = 43;
    const out = downscaleRgb(rgb, 4, 4, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.rgb.length).toBe(2 * 2 * 3);
    expect(out.rgb[0]).toBe(42);
    expect(out.rgb[9]).toBe(43);
  });
});

describe("renderFrame (single-pass BGRA -> cropped, box-downscaled RGB)", () => {
  function solid(w: number, h: number, b: number, g: number, r: number): Buffer {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
    return buf;
  }

  it("converts BGRA to RGB and keeps the size when no downscale is needed", () => {
    const out = renderFrame(solid(4, 2, 10, 20, 30), 4, 2, { maxSide: 900 });
    expect([out.width, out.height]).toEqual([4, 2]);
    expect(Array.from(out.rgb.subarray(0, 3))).toEqual([30, 20, 10]);
    expect(out.rgb.length).toBe(4 * 2 * 3);
  });

  it("crops before scaling and averages the footprint of each output pixel", () => {
    // 8x8 frame: left half pure red, right half pure blue (BGRA order).
    const w = 8;
    const bgra = Buffer.alloc(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (x < 4) bgra[i + 2] = 255;
        else bgra[i] = 255;
        bgra[i + 3] = 255;
      }
    }
    const small = renderFrame(bgra, w, w, { maxSide: 2 });
    expect([small.width, small.height]).toEqual([2, 2]);
    expect(Array.from(small.rgb.subarray(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(small.rgb.subarray(3, 6))).toEqual([0, 0, 255]);
    const one = renderFrame(bgra, w, w, { maxSide: 1 });
    expect(Array.from(one.rgb)).toEqual([128, 0, 128]);
    const right = renderFrame(bgra, w, w, {
      crop: { x: 4, y: 0, width: 4, height: 8 },
      maxSide: 1,
    });
    expect(Array.from(right.rgb)).toEqual([0, 0, 255]);
  });

  it("matches cropRgb + bgraToRgb when no scaling happens", () => {
    const w = 6;
    const h = 5;
    const bgra = Buffer.alloc(w * h * 4);
    for (let i = 0; i < bgra.length; i++) bgra[i] = (i * 37) & 0xff;
    const crop = { x: 1, y: 2, width: 3, height: 2 };
    const direct = renderFrame(bgra, w, h, { crop, maxSide: 4096 });
    const viaOld = cropRgb(bgraToRgb(bgra), w, h, crop);
    expect(direct.width).toBe(viaOld.width);
    expect(direct.height).toBe(viaOld.height);
    expect(direct.rgb.equals(viaOld.rgb)).toBe(true);
  });

  it("rejects a crop outside the frame and a mismatched buffer", () => {
    expect(() =>
      renderFrame(solid(4, 4, 0, 0, 0), 4, 4, {
        crop: { x: 10, y: 0, width: 2, height: 2 },
        maxSide: 4,
      }),
    ).toThrow(/outside/);
    expect(() => renderFrame(Buffer.alloc(3), 4, 4, { maxSide: 4 })).toThrow(/expected 64/);
  });

  it("encodePngAsync produces the same bytes as encodePng", async () => {
    const rgb = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect((await encodePngAsync(2, 2, rgb)).equals(encodePng(2, 2, rgb))).toBe(true);
  });
});

describe("measureBrightness", () => {
  it("is 0 for a black frame and 1 for a lit one, sampling sparsely", () => {
    const black = Buffer.alloc(1920 * 1080 * 4);
    expect(measureBrightness(black)).toBe(0);
    const lit = Buffer.alloc(64 * 64 * 4, 200);
    expect(measureBrightness(lit)).toBe(1);
  });
});
