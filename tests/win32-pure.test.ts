import { describe, expect, it } from "vitest";
import { isGameWindowTitle } from "../src/win/win32.js";

describe("isGameWindowTitle", () => {
  it("accepts the real FiveM game window titles", () => {
    expect(isGameWindowTitle("FiveM® by Cfx.re - breeze standalone [dev]")).toBe(true);
    expect(isGameWindowTitle("FiveM")).toBe(true);
    expect(isGameWindowTitle("FiveM by Cfx.re - something")).toBe(true);
  });

  it("rejects everything merely starting with the letters", () => {
    expect(isGameWindowTitle("fivem-mcp/docs/plan.md at master - Google Chrome")).toBe(false);
    expect(isGameWindowTitle("FiveM-server notes - Notepad")).toBe(false);
    expect(isGameWindowTitle("FiveMthing")).toBe(false);
    expect(isGameWindowTitle("")).toBe(false);
  });
});
