import { InvalidQueryError, isDocument } from "../protocol/index.ts"
import {
  DEFAULT_LIMITS,
  parseExpression,
  parseFilter,
  type QueryLimits,
  validatePath,
} from "../query/index.ts"
import { type PolicyEngine, toFilter } from "./engine.ts"
import { canAccess, toProjection } from "./fields.ts"
import { type RequestContext, Role } from "./model.ts"
import { SEARCH_STAGES, secureSearchStage } from "./search.ts"

/** Limits on caller pipelines. */
export interface PipelineLimits {
  /** Maximum stages, counting those inside `$facet`, `$lookup` and `$unionWith`. */
  readonly maxStages: number
  /** Maximum `$sample` size. */
  readonly maxSample: number
  readonly query: QueryLimits
}

/** Options of {@link securePipeline}. */
export interface SecurePipelineOptions {
  /**
   * Allows `$search` and `$vectorSearch` as the first stage, for a collection with a search index the app
   * opted in. @default false
   */
  readonly search?: boolean
  /** The most documents `$vectorSearch` may ask for. @default 1000 */
  readonly maxSearchResults?: number
}

/** Default pipeline limits. */
export const DEFAULT_PIPELINE_LIMITS: PipelineLimits = {
  maxStages: 20,
  maxSample: 1000,
  query: DEFAULT_LIMITS,
}

type Stage = Record<string, unknown>

/** Stages whose operand is checked as an aggregation expression and kept as it is. */
const EXPRESSION_STAGES = new Set([
  "$project",
  "$addFields",
  "$set",
  "$group",
  "$bucket",
  "$bucketAuto",
  "$sortByCount",
  "$replaceRoot",
  "$replaceWith",
  "$densify",
  "$fill",
  "$setWindowFields",
  "$sort",
])

const LOOKUP_KEYS = new Set(["from", "localField", "foreignField", "let", "pipeline", "as"])
const UNION_KEYS = new Set(["coll", "pipeline"])

function fail(message: string): never {
  throw new InvalidQueryError(message)
}

interface State {
  readonly engine: PolicyEngine
  readonly ctx: RequestContext
  readonly limits: PipelineLimits
  stages: number
}

/**
 * Makes a caller's aggregation pipeline safe to run on `collection`. The result starts with
 * `{ $match: USING(read) }` and a projection of the readable fields, so every later stage only sees what
 * the caller may read. `$lookup` and `$unionWith` must name collections the caller may read, and get the
 * same prefix for that collection inside their pipeline; `$lookup` joins only on readable foreign fields,
 * because the join runs on the foreign documents before their pipeline does. Stages outside the allowlist
 * (`$out`, `$merge`, `$graphLookup`, `$search`, the diagnostic stages and anything unknown) are rejected,
 * and so are `$function`, `$accumulator`, `$where` and system variables other than `$$NOW`, `$$ROOT`,
 * `$$CURRENT` and `$$REMOVE`.
 *
 * With `options.search`, the pipeline may start with `$search` or `$vectorSearch`; the prefix then follows
 * that stage, so the search runs over the collection and the policy filters its results before any later
 * stage. Every field the search uses must be readable for the caller, and operators that can match any
 * field (`queryString`, `moreLikeThis`, wildcard paths) need every field readable. Throws
 * {@link InvalidQueryError}.
 */
export function securePipeline(
  engine: PolicyEngine,
  collection: string,
  pipeline: unknown,
  ctx: RequestContext,
  limits: PipelineLimits = DEFAULT_PIPELINE_LIMITS,
  options: SecurePipelineOptions = {},
): Stage[] {
  const state: State = { engine, ctx, limits, stages: 0 }
  const first: unknown = Array.isArray(pipeline) ? pipeline[0] : undefined
  const name = isDocument(first) ? Object.keys(first)[0] : undefined
  if (
    options.search !== true ||
    first === undefined ||
    name === undefined ||
    !SEARCH_STAGES.has(name)
  )
    return [...prefix(state, collection), ...stages(state, pipeline, "The pipeline")]
  if (!isDocument(first) || Object.keys(first).length !== 1)
    fail("A stage must have exactly one key")
  state.stages += 1
  const searchStage = ctx.roles.has(Role.Service)
    ? { [name]: first[name] }
    : secureSearchStage(
        {
          readable: engine.readable(collection, ctx),
          maxResults: options.maxSearchResults ?? 1000,
        },
        name,
        first[name],
      )
  return [
    searchStage,
    ...prefix(state, collection),
    ...stages(state, (pipeline as unknown[]).slice(1), "The pipeline"),
  ]
}

/** The stages that restrict a collection to what the caller may read. */
function prefix(state: State, collection: string): Stage[] {
  const { engine, ctx } = state
  if (ctx.roles.has(Role.Service)) return []
  const out: Stage[] = []
  const using = engine.using(collection, "read", ctx)
  if (using.kind !== "all") out.push({ $match: toFilter(using) })
  const projection = toProjection(engine.readable(collection, ctx))
  if (projection !== undefined) out.push({ $project: projection })
  return out
}

function readableCollection(state: State, name: unknown, stage: string): string {
  if (typeof name !== "string" || name === "" || name.includes("$") || name.startsWith("system."))
    fail(`${stage} needs a collection name`)
  const { engine, ctx } = state
  if (ctx.roles.has(Role.Service)) return name
  if (!engine.isExposed(name) || !engine.hasGrant(name, "read", ctx))
    fail(`${stage} cannot read from '${name}'`)
  return name
}

function stages(state: State, input: unknown, what: string): Stage[] {
  if (!Array.isArray(input)) fail(`${what} must be an array of stages`)
  return input.map((stage) => sanitizeStage(state, stage))
}

function sanitizeStage(state: State, input: unknown): Stage {
  if (!isDocument(input)) fail("A stage must be a document")
  const keys = Object.keys(input)
  const [name] = keys
  if (name === undefined || keys.length !== 1) fail("A stage must have exactly one key")
  state.stages += 1
  if (state.stages > state.limits.maxStages)
    fail(`A pipeline may not have more than ${state.limits.maxStages} stages`)
  const value = input[name]
  const query = state.limits.query
  if (EXPRESSION_STAGES.has(name)) {
    parseExpression(value, query)
    return { [name]: value }
  }
  switch (name) {
    case "$match":
      if (!isDocument(value)) fail("$match needs a document")
      if (Object.hasOwn(value, "$text")) fail("$text is not supported in aggregations")
      parseFilter(value, { context: "filter", expressions: true, limits: query })
      return { $match: value }
    case "$limit":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
        fail("$limit needs a positive integer")
      return { $limit: value }
    case "$skip":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        fail("$skip needs a non negative integer")
      return { $skip: value }
    case "$count":
      if (typeof value !== "string" || value === "" || value.startsWith("$") || value.includes("."))
        fail("$count needs a field name")
      return { $count: value }
    case "$unset": {
      const paths = typeof value === "string" ? [value] : value
      if (!Array.isArray(paths) || paths.length === 0)
        fail("$unset needs a path or a list of paths")
      for (const path of paths) {
        if (typeof path !== "string") fail("$unset needs field paths")
        validatePath(path, { maxLength: query.maxPathLength })
      }
      return { $unset: value }
    }
    case "$unwind":
      parseExpression(value, query)
      if (typeof value !== "string" && !isDocument(value))
        fail("$unwind needs a path or a document")
      return { $unwind: value }
    case "$sample": {
      const size = isDocument(value) ? value["size"] : undefined
      if (
        !isDocument(value) ||
        Object.keys(value).length !== 1 ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 1
      )
        fail("$sample needs { size: n }")
      if (size > state.limits.maxSample)
        fail(`$sample may not take more than ${state.limits.maxSample} documents`)
      return { $sample: { size } }
    }
    case "$facet": {
      if (!isDocument(value) || Object.keys(value).length === 0)
        fail("$facet needs named pipelines")
      const out: Record<string, Stage[]> = {}
      for (const [branch, pipeline] of Object.entries(value)) {
        if (branch === "" || branch.startsWith("$") || branch.includes("."))
          fail("$facet outputs need field names")
        out[branch] = stages(state, pipeline, `The $facet pipeline ${branch}`)
      }
      return { $facet: out }
    }
    case "$lookup":
      return { $lookup: sanitizeLookup(state, value) }
    case "$unionWith":
      return { $unionWith: sanitizeUnion(state, value) }
    default:
      if (SEARCH_STAGES.has(name) || name === "$searchMeta")
        fail(
          `The stage ${name} is not allowed here: only $search and $vectorSearch, as the first stage on a collection with search turned on`,
        )
      return fail(`The stage ${name} is not allowed`)
  }
}

function sanitizeLookup(state: State, value: unknown): Stage {
  if (!isDocument(value)) fail("$lookup needs a document")
  for (const key of Object.keys(value)) {
    if (!LOOKUP_KEYS.has(key)) fail(`Unknown $lookup field ${key}`)
  }
  const from = readableCollection(state, value["from"], "$lookup")
  const as = value["as"]
  if (typeof as !== "string" || as === "") fail("$lookup needs as")
  validatePath(as, { maxLength: state.limits.query.maxPathLength })
  const out: Stage = { from }
  const local = value["localField"]
  const foreign = value["foreignField"]
  if ((local === undefined) !== (foreign === undefined))
    fail("$lookup needs both localField and foreignField, or neither")
  if (local !== undefined) {
    if (typeof local !== "string" || typeof foreign !== "string")
      fail("localField and foreignField must be field paths")
    validatePath(local, { maxLength: state.limits.query.maxPathLength })
    validatePath(foreign, { maxLength: state.limits.query.maxPathLength })
    if (!canAccess(state.engine.readable(from, state.ctx), foreign))
      fail(`$lookup cannot join on the unreadable field ${foreign} of '${from}'`)
    out["localField"] = local
    out["foreignField"] = foreign
  }
  const bindings = value["let"]
  if (bindings !== undefined) {
    if (!isDocument(bindings)) fail("$lookup let needs a document")
    for (const name of Object.keys(bindings)) {
      if (!/^[a-z][A-Za-z0-9_]*$/.test(name))
        fail(`The variable name ${name} must start with a lower case letter`)
    }
    parseExpression(bindings, state.limits.query)
    out["let"] = bindings
  }
  const sub =
    value["pipeline"] === undefined ? [] : stages(state, value["pipeline"], "$lookup pipeline")
  out["pipeline"] = [...prefix(state, from), ...sub]
  out["as"] = as
  return out
}

function sanitizeUnion(state: State, value: unknown): Stage {
  const spec = typeof value === "string" ? { coll: value } : value
  if (!isDocument(spec)) fail("$unionWith needs a collection name or a document")
  for (const key of Object.keys(spec)) {
    if (!UNION_KEYS.has(key)) fail(`Unknown $unionWith field ${key}`)
  }
  const coll = readableCollection(state, spec["coll"], "$unionWith")
  const sub =
    spec["pipeline"] === undefined ? [] : stages(state, spec["pipeline"], "$unionWith pipeline")
  return { coll, pipeline: [...prefix(state, coll), ...sub] }
}
