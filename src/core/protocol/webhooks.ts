/** The headers of a signed webhook request, as the Standard Webhooks specification names them. */
export interface WebhookHeaders {
  readonly "webhook-id": string
  readonly "webhook-timestamp": string
  readonly "webhook-signature": string
}

/** Options of {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
  /** How far the timestamp may be from now, in seconds. @default 300 */
  readonly toleranceSeconds?: number
  /** The current time in milliseconds, for tests. @default Date.now() */
  readonly now?: number
}

const PREFIX = "whsec_"
const encoder = new TextEncoder()

function base64(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith(PREFIX)) return encoder.encode(secret)
  const text = atob(secret.slice(PREFIX.length))
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i)
  return bytes
}

async function hmac(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(content))))
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

/**
 * The `webhook-signature` value of a message: `v1,` and the base64 HMAC SHA-256 of `id.timestamp.body`. A
 * secret of the form `whsec_<base64>` is used as the bytes it encodes, any other secret as its UTF-8 bytes.
 */
export async function signWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  return `v1,${await hmac(secret, `${id}.${timestampSeconds}.${body}`)}`
}

/** The three signature headers of a webhook request sent now (or at `now`, in milliseconds). */
export async function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  now: number = Date.now(),
): Promise<WebhookHeaders> {
  const timestamp = Math.floor(now / 1000)
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signWebhook(secret, id, timestamp, body),
  }
}

/**
 * Checks a webhook request Canopy sent: one of the space separated `v1` signatures must match the body, and
 * the timestamp must be within the tolerance, which stops replays. Pass the raw body text, before parsing,
 * and the headers as a `Headers` object or a plain object with lower case names (such as Node's
 * `request.headers`).
 * Returns `false` for a missing header, a stale timestamp or a wrong signature.
 */
export async function verifyWebhook(
  secret: string,
  headers:
    Headers | WebhookHeaders | Readonly<Record<string, string | readonly string[] | undefined>>,
  body: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  const read = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined
    const value = (headers as Readonly<Record<string, string | readonly string[] | undefined>>)[
      name
    ]
    return typeof value === "string" ? value : value?.[0]
  }
  const id = read("webhook-id")
  const timestamp = read("webhook-timestamp")
  const signatures = read("webhook-signature")
  if (id === undefined || timestamp === undefined || signatures === undefined) return false
  if (!/^\d+$/.test(timestamp)) return false
  const now = Math.floor((options.now ?? Date.now()) / 1000)
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300)) return false
  const expected = await signWebhook(secret, id, Number(timestamp), body)
  return signatures.split(" ").some((signature) => sameText(signature, expected))
}
