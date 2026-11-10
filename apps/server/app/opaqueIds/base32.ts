/** RFC 4648 base32, lower case, no padding: the alphabet has no `-`, `.`, `:`, `~` or `_`, so a token never contains an id delimiter. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Strict: exactly `bytes` bytes, only alphabet characters, zero padding bits. Anything else is null (a token has one spelling). */
export function base32Decode(text: string, bytes: number): Buffer | null {
  if (text.length !== Math.ceil((bytes * 8) / 5)) return null;
  const out = Buffer.alloc(bytes);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}
