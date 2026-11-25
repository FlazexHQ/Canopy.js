/** The operations a policy can grant. */
export type Operation = "read" | "insert" | "update" | "delete"

/** Every operation, in canonical order. */
export const OPERATIONS: readonly Operation[] = ["read", "insert", "update", "delete"]

/** `permissive` policies are combined with OR, `restrictive` ones with AND. */
export type PolicyKind = "permissive" | "restrictive"

/** Roles with a fixed meaning. `service` can never appear in a policy, because it bypasses DLS. */
export const Role = {
  Anon: "anon",
  Authenticated: "authenticated",
  Public: "public",
  Service: "service",
} as const

/** A filter document as authored, possibly containing policy variables. */
export type FilterTemplate = Readonly<Record<string, unknown>>

/** One policy in authoring form. */
export interface PolicyDefinition {
  readonly name: string
  readonly kind: PolicyKind
  readonly ops: readonly Operation[]
  readonly roles: readonly string[]
  readonly using?: FilterTemplate
  readonly check?: FilterTemplate
}

/** A field rule: either a list of readable or writable paths, or a list of hidden ones. `'*'` means every field. */
export type FieldRule = { readonly only: readonly string[] } | { readonly omit: readonly string[] }

/** Field rules keyed by role, with `default` for roles without an entry. */
export type FieldRules = Readonly<Record<string, FieldRule>>

/** Field level rules for one collection. */
export interface CollectionFields {
  readonly read?: FieldRules
  readonly write?: FieldRules
  readonly update?: FieldRules
}

/** The policies of one collection in authoring form (the output of the DSL). */
export interface CollectionPolicies {
  readonly collection: string
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: readonly PolicyDefinition[]
  readonly fields?: CollectionFields
  readonly immutable?: readonly string[]
}

/** A declared context lookup. */
export interface ContextLookup {
  readonly from: string
  readonly where: FilterTemplate
  readonly select: string
  readonly max: number
  readonly ttl: string
}

/** Context lookups by name. */
export type ContextDefinitions = Readonly<Record<string, ContextLookup>>

/** The request context every evaluation runs under. */
export interface RequestContext {
  /** Exactly one base role (`anon` or `authenticated`) plus custom roles, or `service` alone. */
  readonly roles: ReadonlySet<string>
  /** The verified JWT payload, or `null` for `anon`. */
  readonly claims: Readonly<Record<string, unknown>> | null
  /** Resolved context lookups. A missing name counts as a missing value. */
  readonly ctx?: Readonly<Record<string, unknown>>
  /** Request time, or for realtime the time the event is processed. */
  readonly now: Date
}

/**
 * The reserved policy collection of storage: its policies apply to the metadata documents of stored files
 * (`bucket`, `path`, `owner`, `size`, `contentType`, `metadata`), never to an app collection, so the Data
 * API, GraphQL and realtime do not serve it.
 */
export const STORAGE_COLLECTION = "storage.objects"
