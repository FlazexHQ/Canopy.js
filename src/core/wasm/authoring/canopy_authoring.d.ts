/* tslint:disable */
/* eslint-disable */

/**
 * Document Level Security for one validated set of policies, evaluated in WebAssembly. Each call takes the
 * request context as EJSON text and returns results as canonical EJSON text, byte identical to the
 * TypeScript engine.
 */
export class PolicyEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `CHECK(op)` for one request: what resulting documents must satisfy.
     */
    check(collection: string, op: string, request: string): any;
    /**
     * The context lookups the policies of `collections` may use for a request with these roles, or of every
     * collection when `collections` is `null`, sorted.
     */
    contextNames(collections: string[] | null | undefined, roles: string[]): string[];
    /**
     * The effective read filter: the caller's filter, given as EJSON text, AND `USING(read)`.
     */
    effectiveRead(collection: string, filter: string, request: string): any;
    /**
     * Parses and compiles a canonical authoring bundle.
     */
    static fromCanonical(text: string): PolicyEngine;
    /**
     * Whether any permissive policy grants `op` to the request's roles.
     */
    hasGrant(collection: string, op: string, request: string): boolean;
    /**
     * Validates the policies of each collection, given in their stored form as EJSON text, and the context
     * lookups, given as the EJSON text of their stored form or `null`, and builds the engine. Throws the same
     * refusals as the TypeScript `createPolicySet`.
     */
    constructor(collections: string[], contexts: string);
    /**
     * The fields the request may read.
     */
    readable(collection: string, request: string): any;
    /**
     * The target of an update or delete: `USING(op) AND USING(read)`.
     */
    target(collection: string, op: string, request: string): any;
    /**
     * `USING(op)` for one request: which existing documents the operation may touch.
     */
    using(collection: string, op: string, request: string): any;
    /**
     * The fields the request may write. `update` rules override `write` rules for updates.
     */
    writable(collection: string, op: string, request: string): any;
    /**
     * The bundle version of the loaded policies, a hash over every collection and the context lookups.
     */
    readonly version: string;
}

/**
 * The canonical text of a query, used as the observer key. Byte identical to the TypeScript `canonicalQuery`.
 */
export function canonicalQuery(key: any): string;

/**
 * Validates a query document and returns the canonical observer key.
 */
export function canonicalizeQuery(collection: string, text: string): string;

/**
 * The engine behind this build, always `wasm`.
 */
export function engine(): string;

/**
 * Explains a policy set's decision for the requested collection and operation.
 */
export function explainPolicySet(bundle: string, collection: string, operation: string, context: string, filter?: string | null): string;

/**
 * Infers the schema of one collection from consecutive BSON documents.
 */
export function inferSchema(name: string, documents: Uint8Array | number[], enums: boolean, max_values?: number | null, min_samples?: number | null): string;

/**
 * The hash of the canonical text of a query, `sha256:<hex>`. Byte identical to the TypeScript `queryHash`.
 */
export function queryHash(key: any): string;

/**
 * Applies field access to a collection shape given as authoring JSON.
 */
export function restrictSchema(text: string, access: string, paths: string[], mode: string): string;

/**
 * Converts a MongoDB JSON Schema validator given as EJSON into an authoring shape.
 */
export function shapeFromJsonSchema(text: string): string;

/**
 * Validates a whole bundle (JSON text) and returns the bundle version of its policies, or `undefined` when
 * it has none.
 */
export function validateBundle(text: string): string | undefined;

/**
 * Validates a canonical collection schema document (JSON text).
 */
export function validateCollectionSchemaDocument(text: string): void;

/**
 * Validates a canonical unresolved config document (JSON text).
 */
export function validateConfigDocument(text: string): void;

/**
 * Checks a data plane launcher configuration against the Rust resolver and its defaults.
 */
export function validateLauncherConfig(text: string): void;

/**
 * Validates a canonical policy bundle and returns its compiled bundle version.
 */
export function validatePolicySet(text: string): string;

/**
 * Validates a canonical policy set (JSON text) and returns its bundle version, the hash publishing stores.
 */
export function validatePolicySetDocument(text: string): string;

/**
 * Validates one canonical policy test case (JSON text).
 */
export function validatePolicyTestDocument(text: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_policyengine_free: (a: number, b: number) => void;
    readonly canonicalQuery: (a: number, b: number) => void;
    readonly canonicalizeQuery: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly engine: (a: number) => void;
    readonly explainPolicySet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly inferSchema: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_check: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_contextNames: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly policyengine_effectiveRead: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_fromCanonical: (a: number, b: number, c: number) => void;
    readonly policyengine_hasGrant: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly policyengine_readable: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly policyengine_target: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_using: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly policyengine_version: (a: number, b: number) => void;
    readonly policyengine_writable: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly queryHash: (a: number, b: number) => void;
    readonly restrictSchema: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly shapeFromJsonSchema: (a: number, b: number, c: number) => void;
    readonly validateBundle: (a: number, b: number, c: number) => void;
    readonly validateCollectionSchemaDocument: (a: number, b: number, c: number) => void;
    readonly validateConfigDocument: (a: number, b: number, c: number) => void;
    readonly validateLauncherConfig: (a: number, b: number, c: number) => void;
    readonly validatePolicySet: (a: number, b: number, c: number) => void;
    readonly validatePolicySetDocument: (a: number, b: number, c: number) => void;
    readonly validatePolicyTestDocument: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
