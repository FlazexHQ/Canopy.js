import type {
  Auth0Input,
  BuiltinAuthInput,
  ClaimsHookFunction,
  ClerkInput,
  ExternalAuthInput,
  FirebaseInput,
  LogTransportInput,
  PostmarkTransportInput,
  ResendTransportInput,
  SesTransportInput,
  SmtpTransportInput,
  SupabaseInput,
} from "./types.ts"

type Without<T> = Omit<T, "kind">

/**
 * Bring your own identity provider: tokens are verified against its JWKS with a pinned algorithm, and
 * `iss` and `aud` are required. Presets fill in the endpoints of common providers.
 */
export const external: {
  (options: Without<ExternalAuthInput>): ExternalAuthInput
  /** Auth0: `external.auth0({ domain: env("AUTH0_DOMAIN"), audience: "https://api.example.com" })`. */
  auth0(options: Without<Auth0Input>): Auth0Input
  /** Clerk, through a JWT template that sets `aud`. */
  clerk(options: Without<ClerkInput>): ClerkInput
  /** Firebase Authentication ID tokens of one project. */
  firebase(options: Without<FirebaseInput>): FirebaseInput
  /** Supabase Auth with asymmetric signing keys. */
  supabase(options: Without<SupabaseInput>): SupabaseInput
} = Object.assign(
  (options: Without<ExternalAuthInput>): ExternalAuthInput => ({ kind: "external", ...options }),
  {
    auth0: (options: Without<Auth0Input>): Auth0Input => ({ kind: "auth0", ...options }),
    clerk: (options: Without<ClerkInput>): ClerkInput => ({ kind: "clerk", ...options }),
    firebase: (options: Without<FirebaseInput>): FirebaseInput => ({
      kind: "firebase",
      ...options,
    }),
    supabase: (options: Without<SupabaseInput>): SupabaseInput => ({
      kind: "supabase",
      ...options,
    }),
  },
)

/**
 * Built in auth: Canopy stores users in `canopy_auth` and issues EdDSA access tokens. Import `builtin` from
 * `@canopy/server` for a claims hook typed with the app database.
 */
export function builtin<Hook extends ClaimsHookFunction = ClaimsHookFunction>(
  options: Without<BuiltinAuthInput<Hook>> = {},
): BuiltinAuthInput<Hook> {
  return { kind: "builtin", ...options }
}

/** Email delivery for built in auth. */
export const email: {
  smtp(options: Without<SmtpTransportInput>): SmtpTransportInput
  resend(options: Without<ResendTransportInput>): ResendTransportInput
  postmark(options: Without<PostmarkTransportInput>): PostmarkTransportInput
  ses(options: Without<SesTransportInput>): SesTransportInput
  /** Writes emails to the log; refused in production. */
  log(): LogTransportInput
} = {
  smtp: (options) => ({ kind: "smtp", ...options }),
  resend: (options) => ({ kind: "resend", ...options }),
  postmark: (options) => ({ kind: "postmark", ...options }),
  ses: (options) => ({ kind: "ses", ...options }),
  log: () => ({ kind: "log" }),
}
