const MINUTE = 60_000

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

interface Field {
  readonly name: string
  readonly min: number
  readonly max: number
  readonly names?: readonly string[]
  /** The first value `names` stands for. */
  readonly namesFrom?: number
}

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, namesFrom: 0 },
]

/** The most steps a search for the next or previous fire time takes before it gives up. */
const MAX_STEPS = 200_000

/** A parsed cron expression, evaluated in UTC. */
export interface CronSchedule {
  /** The expression as given. */
  readonly expression: string
  /** The first fire time strictly after `after`. */
  next(after: Date): Date
  /** The last fire time at or before `at`. */
  previous(at: Date): Date
}

function fail(expression: string, message: string): never {
  throw new TypeError(`The cron expression "${expression}" is not valid: ${message}`)
}

function parseValue(expression: string, field: Field, text: string): number {
  const lower = text.toLowerCase()
  const named = field.names?.indexOf(lower) ?? -1
  if (named >= 0) return named + (field.namesFrom ?? 0)
  if (!/^\d+$/.test(text)) fail(expression, `${JSON.stringify(text)} is not a ${field.name}`)
  const value = Number(text)
  if (value < field.min || value > field.max)
    fail(expression, `the ${field.name} ${value} is outside ${field.min} to ${field.max}`)
  return value
}

function parseField(expression: string, field: Field, text: string): Set<number> {
  const values = new Set<number>()
  for (const item of text.split(",")) {
    const [range = "", stepText, extra] = item.split("/")
    if (extra !== undefined || range === "")
      fail(expression, `${JSON.stringify(item)} is malformed`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        fail(expression, `the step ${JSON.stringify(stepText)} must be a positive number`)
      step = Number(stepText)
    }
    let low: number
    let high: number
    if (range === "*") {
      low = field.min
      high = field.max
    } else {
      const [from = "", to, more] = range.split("-")
      if (more !== undefined) fail(expression, `${JSON.stringify(range)} is malformed`)
      low = parseValue(expression, field, from)
      high =
        to === undefined
          ? stepText === undefined
            ? low
            : field.max
          : parseValue(expression, field, to)
      if (high < low) fail(expression, `the range ${JSON.stringify(range)} runs backwards`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

/**
 * Parses a five field cron expression (minute, hour, day of month, month, day of week) with lists, ranges,
 * steps, month and day names, and the `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` macros.
 * Times are in UTC. When both day fields are restricted, a day matches when either does, as in cron. Throws
 * `TypeError` for an invalid expression or one that never fires.
 */
export function parseCron(expression: string): CronSchedule {
  const source = MACROS[expression.trim().toLowerCase()] ?? expression.trim()
  const parts = source.split(/\s+/)
  if (parts.length !== 5)
    fail(expression, "it needs five fields: minute, hour, day of month, month and day of week")
  const sets = parts.map((part, index) => {
    const field = FIELDS[index]
    if (field === undefined) return fail(expression, "it has too many fields")
    return parseField(expression, field, part)
  })
  const [minutes, hours, days, months, weekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ]
  if (weekdays.delete(7)) weekdays.add(0)
  const dayRestricted = !(parts[2] ?? "*").startsWith("*")
  const weekdayRestricted = !(parts[4] ?? "*").startsWith("*")
  const dayMatches = (date: Date): boolean => {
    const inMonth = days.has(date.getUTCDate())
    const inWeek = weekdays.has(date.getUTCDay())
    return dayRestricted && weekdayRestricted ? inMonth || inWeek : inMonth && inWeek
  }

  const next = (after: Date): Date => {
    const t = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE)
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (!months.has(t.getUTCMonth() + 1)) {
        t.setUTCMonth(t.getUTCMonth() + 1, 1)
        t.setUTCHours(0, 0, 0, 0)
      } else if (!dayMatches(t)) {
        t.setUTCDate(t.getUTCDate() + 1)
        t.setUTCHours(0, 0, 0, 0)
      } else if (!hours.has(t.getUTCHours())) {
        t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0)
      } else if (!minutes.has(t.getUTCMinutes())) {
        t.setTime(t.getTime() + MINUTE)
      } else {
        return t
      }
    }
    return fail(expression, "it never fires")
  }

  const previous = (at: Date): Date => {
    const t = new Date(Math.floor(at.getTime() / MINUTE) * MINUTE)
    for (let step = 0; step < MAX_STEPS; step += 1) {
      if (!months.has(t.getUTCMonth() + 1)) {
        t.setUTCDate(1)
        t.setUTCHours(0, 0, 0, 0)
        t.setTime(t.getTime() - MINUTE)
      } else if (!dayMatches(t)) {
        t.setUTCHours(0, 0, 0, 0)
        t.setTime(t.getTime() - MINUTE)
      } else if (!hours.has(t.getUTCHours())) {
        t.setUTCMinutes(0, 0, 0)
        t.setTime(t.getTime() - MINUTE)
      } else if (!minutes.has(t.getUTCMinutes())) {
        t.setTime(t.getTime() - MINUTE)
      } else {
        return t
      }
    }
    return fail(expression, "it never fires")
  }

  next(new Date(Date.UTC(2000, 0, 1)))
  return { expression, next, previous }
}
