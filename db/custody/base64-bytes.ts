// db/custody/base64-bytes.ts
//
// BASE64 FROM BYTES TO BYTES, WITHOUT A JAVASCRIPT STRING IN BETWEEN.
//
// Node's own base64 codec only speaks strings: `buf.toString('base64')`
// produces one and `Buffer.from(s, 'base64')` consumes one. A JavaScript string
// is immutable and cannot be zeroed, so every call to either leaves a copy of
// the framed value in the heap for as long as the process lives. The
// independent certification of this mechanism measured exactly that: base64
// copies of the value surviving in the launcher heap after the Buffer that
// held it had been zeroed.
//
// These two functions let the deposit and retrieval stages frame the value as
// base64 on the pipe while holding it only in Buffers the caller can zero.
// They are deliberately small, strict, and tested against Node's own codec.
// They do not make the process memory-safe — see OF-CUST-1 in the custody
// realization authority for what remains — they remove the copies that were
// avoidable.

const ALPHABET = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 'ascii')
const PAD = 0x3d // '='

const DECODE = new Int16Array(256).fill(-1)
for (let i = 0; i < ALPHABET.length; i += 1) DECODE[ALPHABET[i]!] = i

/** Standard, padded base64 of `input`, as ASCII bytes. */
export function encodeBase64Bytes(input: Buffer): Buffer {
  const out = Buffer.alloc(Math.ceil(input.length / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < input.length; i += 3) {
    const n = (input[i]! << 16) | (input[i + 1]! << 8) | input[i + 2]!
    out[o++] = ALPHABET[(n >> 18) & 63]!
    out[o++] = ALPHABET[(n >> 12) & 63]!
    out[o++] = ALPHABET[(n >> 6) & 63]!
    out[o++] = ALPHABET[n & 63]!
  }
  const rest = input.length - i
  if (rest > 0) {
    const n = (input[i]! << 16) | (rest === 2 ? input[i + 1]! << 8 : 0)
    out[o++] = ALPHABET[(n >> 18) & 63]!
    out[o++] = ALPHABET[(n >> 12) & 63]!
    out[o++] = rest === 2 ? ALPHABET[(n >> 6) & 63]! : PAD
    out[o++] = PAD
  }
  return out
}

/**
 * Decode standard, padded base64 held as ASCII bytes.
 *
 * STRICT: a length that is not a multiple of four, a character outside the
 * alphabet, or padding anywhere but the end throws. A lenient decoder would
 * silently turn a desynchronised pipe into a wrong credential, which is the
 * one failure a custody reader must never convert into a value.
 */
export function decodeBase64Bytes(input: Buffer): Buffer {
  if (input.length % 4 !== 0) throw new Error('base64 input length is not a multiple of four')
  if (input.length === 0) return Buffer.alloc(0)
  const pad = input[input.length - 1] === PAD ? (input[input.length - 2] === PAD ? 2 : 1) : 0
  const out = Buffer.alloc((input.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < input.length; i += 4) {
    const last = i + 4 === input.length
    const v: number[] = []
    for (let k = 0; k < 4; k += 1) {
      const c = input[i + k]!
      if (c === PAD) {
        if (!last || k < 4 - pad) throw new Error('base64 padding in an invalid position')
        v.push(0)
        continue
      }
      const d = DECODE[c]!
      if (d < 0) throw new Error('base64 input contains a character outside the alphabet')
      v.push(d)
    }
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!
    v.fill(0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}
