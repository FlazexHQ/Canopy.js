/* tslint:disable */
/* eslint-disable */

/**
 * Documents decoded once from BSON and retained between calls, each in a numbered slot, so a filter decides
 * them without decoding again. Release the handle with the generated `free()` method.
 */
export class DocumentCache {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Replaces the first `count` slot numbers in scratch space with their decisions.
     */
    matchBatch(filter: Filter, count: number): void;
    /**
     * Decides the retained documents of `slots` with `filter`, one byte per slot as `matchConcatenated`
     * returns them; a slot that holds no document is undecided.
     */
    matchFilter(filter: Filter, slots: Uint32Array | number[]): Uint8Array;
    /**
     * An empty cache.
     */
    constructor();
    /**
     * Releases slots, so they can hold other documents. Slots that hold nothing are ignored.
     */
    release(slots: Uint32Array | number[]): void;
    /**
     * Reserves scratch space for slot numbers and returns its byte offset in linear memory.
     */
    reserveMatchBatch(capacity: number): number;
    /**
     * Decodes BSON documents laid end to end and retains each one. Returns their slots, in order. Throws, and
     * retains nothing, when the BSON is malformed.
     */
    retain(documents: Uint8Array | number[]): Uint32Array;
}

/**
 * An owned page of BSON documents. Release the handle with the generated `free()` method.
 */
export class DocumentPage {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns the page as consecutive BSON documents.
     */
    bson(): Uint8Array;
    /**
     * Decodes consecutive BSON documents into an owned page.
     */
    static fromBson(bytes: Uint8Array | number[]): DocumentPage;
    /**
     * Returns one decision byte per document, in page order.
     */
    matchFilter(filter: Filter): Uint8Array;
}

/**
 * A MongoDB query filter compiled once and matched against documents given as BSON or EJSON.
 */
export class Filter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Compiles a BSON filter, preserving legacy BSON values and field order.
     */
    static fromBson(bytes: Uint8Array | number[]): Filter;
    /**
     * Compiles a filter given as EJSON text (relaxed or canonical).
     */
    static fromEjson(text: string): Filter;
    /**
     * Matches BSON documents laid end to end in one buffer, as a batch of change events is. Returns one byte
     * per document: 0 for no match, 1 for a match, 2 when the decision is unknown (malformed BSON, or an input
     * the matcher refuses to evaluate), which callers treat as a refusal. Throws when the framing itself is
     * broken, since no document after that point can be located.
     */
    matchConcatenated(documents: Uint8Array | number[]): Uint8Array;
}

/**
 * Decodes one BSON document into EJSON text: canonical when `canonical` is true, relaxed otherwise.
 */
export function bsonToEjson(bytes: Uint8Array | number[], canonical: boolean): string;

/**
 * Parses and canonicalizes arbitrary EJSON, including arrays and scalar BSON values.
 */
export function canonicalEjson(text: string): string;

/**
 * Encodes a document given as EJSON text into BSON.
 */
export function ejsonToBson(text: string): Uint8Array;

/**
 * The engine behind this build, always `wasm`.
 */
export function engine(): string;


/** Returns the current linear memory buffer for the document cache batch. */
export function matchBatchMemory(): ArrayBuffer;
