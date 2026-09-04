// Byte-level reproductions of the hashes CitizenFX computes on the wire.
//
// Reference: citizenfx/fivem@03dcc56 (2026-09-01), code/client/shared/Utils.h:254-271
// (`HashRageString`, `HashString`). Both are the classic djb2-style one-at-a-time mixer,
// computed over the string's *bytes* with 32-bit wrapping arithmetic. `char` is signed
// on MSVC, so bytes >= 0x80 are added sign-extended; the shifts are done on the
// unsigned accumulator. The two differ only in whether ASCII letters are lowercased.

function mix(input: string, lowercase: boolean): number {
  const bytes = Buffer.from(input, "utf8");
  let hash = 0;

  for (const byte of bytes) {
    // C++ signed char: bytes >= 0x80 promote as negative ints.
    let ch = byte < 0x80 ? byte : byte - 0x100;
    if (lowercase && ch >= 0x41 && ch <= 0x5a) ch += 0x20; // ToLower, ASCII only

    hash = (hash + ch) >>> 0;
    hash = (hash + ((hash << 10) | 0)) >>> 0;
    hash = (hash ^ (hash >>> 6)) >>> 0;
  }

  hash = (hash + ((hash << 3) | 0)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  hash = (hash + ((hash << 15) | 0)) >>> 0;
  return hash >>> 0;
}

/**
 * The Cfx `HashString`: hash a string, lowercasing ASCII letters first.
 * Used by the DevCon `PRNT` frame to identify the emitting console channel.
 */
export function hashString(input: string): number {
  return mix(input, true);
}

/**
 * The Cfx `HashRageString`: same mixer without the lowercasing. The server uses
 * it to dispatch out-of-band UDP packets by handler name.
 */
export function hashRageString(input: string): number {
  return mix(input, false);
}
