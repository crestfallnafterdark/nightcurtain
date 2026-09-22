/**
 * Self-contained SHA-256 + UTF-8 primitives for the `realmCatalog` module.
 *
 * The catalog's per-bundle content version must be computable synchronously and
 * identically on every path — baked bundles embedded at build time and bundles
 * imported as JSON at runtime — without asynchronous APIs (`crypto.subtle`),
 * platform crypto (`node:crypto`), or third-party dependencies. This file is
 * therefore a plain, dependency-free implementation of FIPS 180-4 SHA-256 over
 * a UTF-8 byte stream, with a manual UTF-8 encoder (lone surrogates are
 * replaced with U+FFFD, matching `TextEncoder`).
 */

/** SHA-256 round constants (first 32 bits of the fractional parts of the cube roots of the first 64 primes). */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** SHA-256 initial hash values (first 32 bits of the fractional parts of the square roots of the first 8 primes). */
const SHA256_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

/** 32-bit right rotation. */
function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Encodes a JavaScript string as UTF-8 bytes.
 *
 * Surrogate pairs become their four-byte code point; an unpaired surrogate is
 * encoded as U+FFFD, matching `TextEncoder` semantics.
 *
 * @param text - Source text
 * @returns The UTF-8 bytes
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
        index += 1;
        continue;
      }
    }
    const scalar = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
    if (scalar < 0x80) {
      out.push(scalar);
    } else if (scalar < 0x800) {
      out.push(0xc0 | (scalar >> 6), 0x80 | (scalar & 0x3f));
    } else if (scalar < 0x10000) {
      out.push(0xe0 | (scalar >> 12), 0x80 | ((scalar >> 6) & 0x3f), 0x80 | (scalar & 0x3f));
    } else {
      out.push(
        0xf0 | (scalar >> 18),
        0x80 | ((scalar >> 12) & 0x3f),
        0x80 | ((scalar >> 6) & 0x3f),
        0x80 | (scalar & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

/**
 * UTF-8 byte length of a string (without allocating the full byte array).
 *
 * @param text - Source text
 * @returns The number of UTF-8 bytes the text encodes to
 */
export function utf8ByteLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}

/**
 * Computes the `sha256:<hex>` content hash of a UTF-8 string.
 *
 * Shares the module's self-contained synchronous SHA-256 with
 * {@link templateBundleVersion}, so callers that need to record content
 * hashes (for example instance-provenance input hashes) do not need platform
 * crypto, asynchronous `crypto.subtle`, or a deep import into this module.
 *
 * @param text - Source text (encoded as UTF-8)
 * @returns The version-style digest (`sha256:` plus 64 lowercase hex characters)
 * @throws `Error` - When `text` is not a string
 *
 * @example
 * ```typescript
 * import { hashText } from './realmCatalog/index.ts';
 *
 * hashText('abc');
 * // 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
 * ```
 */
export function hashText(text: string): string {
  if (typeof text !== 'string') {
    throw new Error(`hashText text must be a string (got ${typeof text})`);
  }
  return `sha256:${sha256Hex(text)}`;
}

/**
 * Computes the SHA-256 digest of a UTF-8 string.
 *
 * @param text - Source text (encoded as UTF-8)
 * @returns The lowercase 64-character hexadecimal digest
 *
 * @example
 * ```typescript
 * import { sha256Hex } from './sha256.ts';
 *
 * sha256Hex('abc');
 * // 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
 * ```
 */
export function sha256Hex(text: string): string {
  const bytes = utf8Encode(text);
  const bitLengthLow = (bytes.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000) >>> 0;

  const paddedLength = (((bytes.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const tail = paddedLength - 8;
  const view = new DataView(padded.buffer);
  view.setUint32(tail, bitLengthHigh, false);
  view.setUint32(tail + 4, bitLengthLow, false);

  let h0 = SHA256_H[0];
  let h1 = SHA256_H[1];
  let h2 = SHA256_H[2];
  let h3 = SHA256_H[3];
  let h4 = SHA256_H[4];
  let h5 = SHA256_H[5];
  let h6 = SHA256_H[6];
  let h7 = SHA256_H[7];

  let a: number;
  let b: number;
  let c: number;
  let d: number;
  let e: number;
  let f: number;
  let g: number;
  let h: number;

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15];
      const w2 = schedule[index - 2];
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    a = h0;
    b = h1;
    c = h2;
    d = h3;
    e = h4;
    f = h5;
    g = h6;
    h = h7;

    for (let index = 0; index < 64; index += 1) {
      const bigS1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + bigS1 + ch + SHA256_K[index] + schedule[index]) >>> 0;
      const bigS0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (bigS0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('');
}
