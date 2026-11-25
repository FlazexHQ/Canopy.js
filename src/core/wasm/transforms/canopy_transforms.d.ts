/* tslint:disable */
/* eslint-disable */

/**
 * An owned page of BSON documents. Release the handle with the generated `free()` method.
 */
export class DocumentPage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Applies an update document and positional filters supplied as BSON.
     */
    applyBsonUpdate(update: Uint8Array | number[], array_filters: Uint8Array | number[], is_insert: boolean, now?: string | null): void;
    /**
     * Applies one update to all documents. A refusal leaves the page unchanged.
     */
    applyUpdate(update: string, array_filters: string, is_insert: boolean, now?: string | null): void;
    /**
     * Returns the page as consecutive BSON documents.
     */
    bson(): Uint8Array;
    /**
     * Decodes consecutive BSON documents into an owned page.
     */
    static fromBson(bytes: Uint8Array | number[]): DocumentPage;
    /**
     * Projects every document in the page with the same specification.
     */
    project(spec: string): void;
    /**
     * Sorts the page using the MongoDB sort and its implicit identifier tie breaker.
     */
    sort(spec: string): void;
}

/**
 * Documents decoded once and kept for optimistic updates, each in a numbered slot. An update reads the
 * document of one slot and keeps the result in a new slot, so both versions stay available until released.
 * Release the handle with the generated `free()` method.
 */
export class UpdateCache {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * An empty cache.
     */
    constructor();
    /**
     * Releases slots, so they can hold other documents. Slots that hold nothing are ignored.
     */
    release(slots: Uint32Array | number[]): void;
    /**
     * Decodes one BSON document and retains it. Returns its slot. Throws, and retains nothing, when the BSON
     * is malformed.
     */
    retain(document: Uint8Array | number[]): number;
    /**
     * Applies one update (given as BSON) to the document of `slot` and retains the result in a new slot; the
     * document of `slot` is kept as it was. Returns the new slot as four little endian bytes, followed by a
     * BSON document whose `c` field holds the top level fields of the result that the update touched and,
     * when the field names of the result or their order differ from the original's, whose `k` field lists
     * every field name of the result in order. Throws when MongoDB would refuse the update or when `slot`
     * holds no document; nothing is retained then.
     */
    update(slot: number, update: Uint8Array | number[], now?: string | null): Uint8Array;
}

/**
 * The engine behind this build, always `wasm`.
 */
export function engine(): string;

/**
 * Projects BSON documents laid end to end in one buffer with one specification (given as BSON) and returns
 * the results laid end to end in the same order.
 */
export function projectBson(spec: Uint8Array | number[], documents: Uint8Array | number[]): Uint8Array;

/**
 * Orders BSON documents laid end to end in one buffer by a MongoDB sort (given as BSON) and its implicit
 * identifier tie breaker. Returns the position of each document in sorted order, so the caller keeps its own
 * objects. Throws for an invalid sort, malformed BSON or parallel arrays.
 */
export function sortBson(spec: Uint8Array | number[], documents: Uint8Array | number[]): Uint32Array;

/**
 * Applies one update (given as BSON) to BSON documents laid end to end in one buffer and returns the results
 * laid end to end in the same order. A refusal of any document throws, so no partial result is returned.
 */
export function updateBson(update: Uint8Array | number[], documents: Uint8Array | number[], now?: string | null): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_documentpage_free: (a: number, b: number) => void;
    readonly __wbg_updatecache_free: (a: number, b: number) => void;
    readonly documentpage_applyBsonUpdate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly documentpage_applyUpdate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly documentpage_bson: (a: number, b: number) => void;
    readonly documentpage_fromBson: (a: number, b: number, c: number) => void;
    readonly documentpage_project: (a: number, b: number, c: number, d: number) => void;
    readonly documentpage_sort: (a: number, b: number, c: number, d: number) => void;
    readonly engine: (a: number) => void;
    readonly projectBson: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly sortBson: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly updateBson: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly updatecache_new: () => number;
    readonly updatecache_release: (a: number, b: number, c: number) => void;
    readonly updatecache_retain: (a: number, b: number, c: number, d: number) => void;
    readonly updatecache_update: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number, d: number) => number;
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
