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
 * Documents decoded once and kept for optimistic updates, each under an identifier that is never reused. An
 * update reads the document of one identifier and keeps the result under a new one, so both versions stay
 * available. The cache keeps the 256 documents retained last; an update of an older one reports that it is no
 * longer retained, and the caller retains it again. Release the handle with the generated `free()` method.
 *
 * One update crosses the boundary once: the caller writes the update's BSON into the input space that
 * `reserveInput` returns and reads the changes at the offset and length that `update` writes into the two
 * little endian 32 bit words (the width of `usize` in WebAssembly) at `output()`.
 */
export class UpdateCache {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * An empty cache.
     */
    constructor();
    /**
     * The offset in linear memory of the two words where `update` writes the offset and the length of its
     * changes. It stays valid for the life of the cache.
     */
    output(): number;
    /**
     * Makes the input space at least `capacity` bytes long and returns its offset in linear memory. The
     * offset stays valid until the next call of this method.
     */
    reserveInput(capacity: number): number;
    /**
     * Decodes one BSON document and retains it. Returns its identifier. Throws, and retains nothing, when the
     * BSON is malformed.
     */
    retain(document: Uint8Array | number[]): number;
    /**
     * The error of the last refused update, once, or `undefined`.
     */
    takeError(): any;
    /**
     * Applies the update whose BSON fills the first `length` bytes of the input space to the document of
     * `id` and retains the result under a new identifier, which it returns; the document of `id` is kept as
     * it was. The changes are a BSON document whose `c` field holds the top level fields of the result that
     * the update touched and, when the field names of the result or their order differ from the original's,
     * whose `k` field lists every field name of the result in order. They stay valid until the next update.
     * `now` is the clock of `$currentDate` in milliseconds since the Unix epoch. Returns -1 when `id` names
     * no retained document, and -2 when MongoDB would refuse the update (`takeError` returns the error);
     * nothing is retained then.
     */
    update(id: number, length: number, now?: number | null): number;
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


/** Returns the current linear memory buffer for the input and changes of an update. */
export function updateMemory(): ArrayBuffer;
