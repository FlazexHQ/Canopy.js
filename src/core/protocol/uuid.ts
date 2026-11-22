let lastMs = -1
let sequence = 0

/**
 * Generates a UUIDv7 (RFC 9562): a 48 bit millisecond timestamp, then random bits. IDs created in the same
 * millisecond by one process stay ordered through a 12 bit sequence in the `rand_a` field.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  if (nowMs === lastMs) {
    sequence = (sequence + 1) & 0xfff
  } else {
    lastMs = nowMs
    sequence = ((bytes[6] ?? 0) << 4) & 0x7ff
  }
  let ms = Math.max(0, Math.floor(nowMs))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = 0x70 | ((sequence >>> 8) & 0x0f)
  bytes[7] = sequence & 0xff
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Returns true when `value` is a lower case UUIDv7 string. */
export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value)
}
