import { binaryParts, bsonTypeTag } from "../core/protocol/index.ts"
import type { Shape } from "./shape.ts"

/** One problem Standard Schema validation found. */
export interface StandardIssue {
  readonly message: string
  readonly path?: readonly PropertyKey[]
}

/** The result of Standard Schema validation: the value, or the problems found. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] }

/** The `~standard` property of the Standard Schema specification, version 1. */
export interface StandardProps<Input = unknown, Output = Input> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
  readonly types?: { readonly input: Input; readonly output: Output }
}

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (value instanceof Date) return "a date"
  if (typeof value === "object") {
    const name = (value as { _bsontype?: unknown })._bsontype
    return typeof name === "string" ? `a ${name}` : "an object"
  }
  return `a ${typeof value}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Whether a value has a scalar type. BSON values are recognized by their type tag rather than `instanceof`, so
 * documents decoded by the MongoDB driver's own copy of `bson` validate like values from this package.
 */
function scalarMatches(type: string, value: unknown, values?: readonly string[]): boolean {
  const tag = bsonTypeTag(value)
  switch (type) {
    case "string":
      return typeof value === "string" && (values === undefined || values.includes(value))
    case "int":
      return (
        tag === "Int32" ||
        (Number.isInteger(value) &&
          (value as number) >= INT32_MIN &&
          (value as number) <= INT32_MAX)
      )
    case "double":
      return typeof value === "number" || tag === "Double"
    case "long":
      return Number.isSafeInteger(value) || tag === "Long"
    case "decimal":
      return tag === "Decimal128"
    case "bool":
      return typeof value === "boolean"
    case "date":
      return value instanceof Date && !Number.isNaN(value.getTime())
    case "objectId":
      return tag === "ObjectId"
    case "uuid": {
      const parts = binaryParts(value)
      return parts?.subType === 4 && parts.bytes.length === 16
    }
    case "binData":
      return tag === "Binary"
    case "null":
      return value === null
    default:
      return value !== undefined
  }
}

function expected(shape: Shape): string {
  switch (shape.kind) {
    case "any":
      return "any value"
    case "scalar":
      return shape.values === undefined
        ? shape.type
        : `one of ${shape.values.map((value) => JSON.stringify(value)).join(", ")}`
    case "array":
      return "an array"
    case "object":
      return "an object"
    case "union":
      return shape.of.map(expected).join(" or ")
  }
}

function check(
  shape: Shape,
  value: unknown,
  path: readonly PropertyKey[] = [],
  issues: StandardIssue[] = [],
): StandardIssue[] {
  switch (shape.kind) {
    case "any":
      return issues
    case "scalar":
      if (!scalarMatches(shape.type, value, shape.values))
        issues.push({ message: `Expected ${expected(shape)}, got ${describe(value)}`, path })
      return issues
    case "array":
      if (!Array.isArray(value)) {
        issues.push({ message: `Expected an array, got ${describe(value)}`, path })
        return issues
      }
      value.forEach((item, index) => {
        check(shape.items, item, [...path, index], issues)
      })
      return issues
    case "union":
      if (!shape.of.some((member) => check(member, value, path).length === 0))
        issues.push({ message: `Expected ${expected(shape)}, got ${describe(value)}`, path })
      return issues
    case "object": {
      if (!isPlainObject(value)) {
        issues.push({ message: `Expected an object, got ${describe(value)}`, path })
        return issues
      }
      for (const [name, field] of Object.entries(shape.fields)) {
        const item = value[name]
        if (item === undefined) {
          if (field.required) issues.push({ message: "Required", path: [...path, name] })
          continue
        }
        check(field.shape, item, [...path, name], issues)
      }
      if (!shape.open)
        for (const name of Object.keys(value))
          if (shape.fields[name] === undefined)
            issues.push({ message: "Unknown field", path: [...path, name] })
      return issues
    }
  }
}

/** The Standard Schema properties of a shape, validating decoded documents (BSON classes, not EJSON). */
export function standardProps<Output>(shape: Shape): StandardProps<unknown, Output> {
  return Object.freeze({
    version: 1,
    vendor: "canopy",
    validate(value: unknown): StandardResult<Output> {
      const issues = check(shape, value)
      return issues.length === 0 ? { value: value as Output } : { issues }
    },
  })
}
