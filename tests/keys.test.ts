import { describe, expect, it } from "vitest";
import {
  INPUT_SIZE,
  buildKeyPress,
  buildKeyRelease,
  buildKeyboardInput,
  buildMouseInput,
  buildUnicodeText,
  keySpec,
} from "../src/win/keys.js";

describe("SendInput byte layout (x64 INPUT = 40 bytes)", () => {
  it('press "w": type=keyboard, vk/scan at the union offsets, SCANCODE flag', () => {
    const buf = buildKeyPress("w");
    expect(buf.length).toBe(INPUT_SIZE);
    expect(buf.readUInt32LE(0)).toBe(1); // INPUT_KEYBOARD
    expect(buf.readUInt16LE(8)).toBe(0x57); // wVk
    expect(buf.readUInt16LE(10)).toBe(0x11); // wScan (Set 1 make code)
    expect(buf.readUInt32LE(12)).toBe(0x8); // KEYEVENTF_SCANCODE
  });

  it("extended keys carry the EXTENDEDKEY bit", () => {
    const buf = buildKeyPress("right");
    expect(buf.readUInt32LE(12)).toBe(0x8 | 0x1);
    expect(buf.readUInt16LE(10)).toBe(0x4d);
  });

  it("release adds KEYUP", () => {
    const buf = buildKeyRelease("space");
    expect(buf.readUInt32LE(12)).toBe(0x8 | 0x2);
  });

  it("unicode text: down+up per UTF-16 unit, UNICODE flag, char in wScan", () => {
    const buf = buildUnicodeText("hi");
    expect(buf.length).toBe(INPUT_SIZE * 4);
    expect(buf.readUInt32LE(12)).toBe(0x4); // KEYEVENTF_UNICODE
    expect(buf.readUInt16LE(10)).toBe(0x68); // 'h'
    expect(buf.readUInt32LE(INPUT_SIZE + 12)).toBe(0x4 | 0x2); // up of 'h'
    expect(buf.readUInt16LE(INPUT_SIZE * 2 + 10)).toBe(0x69); // 'i' down
    expect(buf.readUInt32LE(INPUT_SIZE * 3 + 12)).toBe(0x4 | 0x2); // 'i' up
  });

  it("surrogate pairs expand to both UTF-16 units", () => {
    const buf = buildUnicodeText("😀"); // U+1F600 -> D83D DE00
    expect(buf.length).toBe(INPUT_SIZE * 4);
    expect(buf.readUInt16LE(10)).toBe(0xd83d);
    expect(buf.readUInt16LE(INPUT_SIZE * 2 + 10)).toBe(0xde00);
  });

  it("mouse input writes the mouse-side offsets", () => {
    const buf = buildMouseInput({ dx: -5, dy: 3, data: 240, flags: 0x800 });
    expect(buf.readUInt32LE(0)).toBe(0); // INPUT_MOUSE
    expect(buf.readInt32LE(8)).toBe(-5);
    expect(buf.readInt32LE(12)).toBe(3);
    expect(buf.readInt32LE(16)).toBe(240);
    expect(buf.readUInt32LE(20)).toBe(0x800);
  });

  it("unknown keys throw", () => {
    expect(() => buildKeyPress("nonexistent-key")).toThrow(/unknown key/);
    expect(keySpec("mouse")).toBeNull();
  });

  it("case-insensitive lookup", () => {
    expect(keySpec("W")).toEqual(keySpec("w"));
  });

  it("modifier virtual keys are the Win32 constants (rshift was VK_CONTROL once)", () => {
    expect(keySpec("rshift")).toEqual({ vk: 0xa1, scan: 0x36 });
    expect(keySpec("rcontrol")).toMatchObject({ vk: 0xa3, extended: true });
    expect(keySpec("alt")).toEqual({ vk: 0xa4, scan: 0x38 });
    expect(keySpec("ralt")).toMatchObject({ vk: 0xa5, scan: 0x38, extended: true });
  });

  it("documented aliases resolve (esc, ctrl, alt)", () => {
    expect(keySpec("esc")).toEqual(keySpec("escape"));
    expect(keySpec("ctrl")).toEqual(keySpec("control"));
    expect(keySpec("alt")).toEqual(keySpec("lalt"));
  });
});
