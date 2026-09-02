import { describe, expect, it } from "vitest";
import { hashRageString, hashString } from "../src/protocol/hash.js";

// Ground-truth vectors computed with a C# reproduction of HashString /
// HashRageString from citizenfx/fivem@03dcc56 code/client/shared/Utils.h:243-283
// (C# uint arithmetic matches the C++ uint32_t wrapping exactly).
const vectors: Array<[string, number]> = [
  ["Any", 3744729013],
  ["font-renderer", 3214374246],
  ["rcon", 2313349815],
  ["server", 581657549],
  ["script:breeze-chat", 1292359553],
  ["citizen:resources:core", 3335894342],
  ["getinfo", 2403156743],
  ["getstatus", 2915652508],
  ["breeze-chat", 1504381307],
];

describe("hashString (Cfx lowercase djb2)", () => {
  for (const [input, expected] of vectors) {
    it(`hashes ${JSON.stringify(input)}`, () => {
      expect(hashString(input)).toBe(expected);
    });
  }

  it("folds ASCII case", () => {
    expect(hashString("RCON")).toBe(hashString("rcon"));
    expect(hashString("Any")).toBe(hashString("any"));
  });

  it("returns unsigned 32-bit values", () => {
    for (const [input] of vectors) {
      const value = hashString(input);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("hashRageString (no lowercasing)", () => {
  it("matches hashString for already-lowercase inputs", () => {
    expect(hashRageString("rcon")).toBe(hashString("rcon"));
    expect(hashRageString("getinfo")).toBe(hashString("getinfo"));
  });

  it("does not fold case", () => {
    expect(hashRageString("Any")).toBe(3190565597);
    expect(hashRageString("Any")).not.toBe(hashString("Any"));
  });
});
