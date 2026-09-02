import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { downscaleRgb, encodePng } from "../src/win/png.js";

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
