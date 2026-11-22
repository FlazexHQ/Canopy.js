import { CanopyError, ErrorCode, InvalidQueryError } from "../protocol/index.ts"
import { UnsupportedQueryError } from "./errors.ts"

/**
 * A regular expression engine with linear time matching (a Pike VM over code points). It accepts the subset
 * of PCRE that RE2 also accepts, so patterns that need backtracking (backreferences, lookaround, atomic groups,
 * possessive quantifiers, recursion) are rejected rather than run.
 */

type CharTest = (cp: number) => boolean

type Node =
  | { readonly k: "char"; readonly test: CharTest }
  | { readonly k: "seq"; readonly items: readonly Node[] }
  | { readonly k: "alt"; readonly items: readonly Node[] }
  | { readonly k: "rep"; readonly node: Node; readonly min: number; readonly max: number }
  | { readonly k: "assert"; readonly kind: AssertKind; readonly multiline: boolean }

type AssertKind = "bol" | "eol" | "start" | "end" | "endz" | "word" | "nonword"

type Inst =
  | { op: "char"; test: CharTest }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "assert"; kind: AssertKind; multiline: boolean }
  | { op: "match" }

interface Flags {
  i: boolean
  m: boolean
  s: boolean
  x: boolean
}

/** Limits that keep compilation and matching bounded. */
export const REGEX_LIMITS = {
  /** Maximum pattern length accepted by {@link compileRegex}. */
  maxPatternLength: 4096,
  /** Maximum count in a `{n,m}` quantifier, as in RE2. */
  maxRepeat: 1000,
  /** Maximum number of VM instructions after expanding counted repetition. */
  maxProgram: 20_000,
  /** Maximum `input length × program size` per match before the match fails with an error. */
  maxSteps: 50_000_000,
} as const

const NOT_LINEAR = "is not supported by the linear time regex engine"

function unsupported(what: string): never {
  throw new UnsupportedQueryError(`Regular expression ${what} ${NOT_LINEAR}`)
}

function syntax(what: string): never {
  throw new InvalidQueryError(`Invalid regular expression: ${what}`)
}

const isDigit: CharTest = (cp) => cp >= 0x30 && cp <= 0x39
const isWordChar: CharTest = (cp) =>
  isDigit(cp) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f
const isSpace: CharTest = (cp) => cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)
const isHorizontalSpace: CharTest = (cp) =>
  cp === 0x09 ||
  cp === 0x20 ||
  cp === 0xa0 ||
  cp === 0x1680 ||
  cp === 0x180e ||
  (cp >= 0x2000 && cp <= 0x200a) ||
  cp === 0x202f ||
  cp === 0x205f ||
  cp === 0x3000
const isVerticalSpace: CharTest = (cp) =>
  (cp >= 0x0a && cp <= 0x0d) || cp === 0x85 || cp === 0x2028 || cp === 0x2029

const POSIX: Readonly<Record<string, CharTest>> = {
  alpha: (cp) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a),
  digit: isDigit,
  alnum: (cp) => isDigit(cp) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a),
  upper: (cp) => cp >= 0x41 && cp <= 0x5a,
  lower: (cp) => cp >= 0x61 && cp <= 0x7a,
  space: isSpace,
  blank: (cp) => cp === 0x20 || cp === 0x09,
  punct: (cp) =>
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e),
  xdigit: (cp) => isDigit(cp) || (cp >= 0x41 && cp <= 0x46) || (cp >= 0x61 && cp <= 0x66),
  word: isWordChar,
  cntrl: (cp) => cp < 0x20 || cp === 0x7f,
  graph: (cp) => cp > 0x20 && cp < 0x7f,
  print: (cp) => cp >= 0x20 && cp < 0x7f,
}

function foldVariants(cp: number): number[] {
  const char = String.fromCodePoint(cp)
  const variants = new Set<number>([cp])
  for (const mapped of [char.toLowerCase(), char.toUpperCase()]) {
    const first = mapped.codePointAt(0)
    if (first !== undefined && [...mapped].length === 1) variants.add(first)
  }
  return [...variants]
}

function caseless(test: CharTest): CharTest {
  return (cp) => {
    if (test(cp)) return true
    for (const variant of foldVariants(cp)) if (variant !== cp && test(variant)) return true
    return false
  }
}

class Parser {
  private readonly cps: number[]
  private pos = 0
  private flags: Flags

  constructor(pattern: string, flags: Flags) {
    this.cps = [...pattern].map((char) => char.codePointAt(0) ?? 0)
    this.flags = { ...flags }
  }

  parse(): Node {
    const node = this.parseAlt()
    if (this.pos < this.cps.length) syntax("unmatched )")
    return node
  }

  private peek(offset = 0): number | undefined {
    return this.cps[this.pos + offset]
  }

  private eat(cp: number): boolean {
    if (this.peek() === cp) {
      this.pos += 1
      return true
    }
    return false
  }

  private skipExtended(): void {
    if (!this.flags.x) return
    for (;;) {
      const cp = this.peek()
      if (cp === undefined) return
      if (isSpace(cp)) {
        this.pos += 1
      } else if (cp === 0x23) {
        while (this.peek() !== undefined && this.peek() !== 0x0a) this.pos += 1
      } else {
        return
      }
    }
  }

  private parseAlt(): Node {
    const items: Node[] = [this.parseSeq()]
    while (this.eat(0x7c)) items.push(this.parseSeq())
    return items.length === 1 ? (items[0] as Node) : { k: "alt", items }
  }

  private parseSeq(): Node {
    const items: Node[] = []
    const saved = { ...this.flags }
    for (;;) {
      this.skipExtended()
      const cp = this.peek()
      if (cp === undefined || cp === 0x7c || cp === 0x29) break
      const atom = this.parseAtom()
      if (atom === undefined) continue
      items.push(this.parseQuantifier(atom))
    }
    this.flags = saved
    return items.length === 1 ? (items[0] as Node) : { k: "seq", items }
  }

  private parseQuantifier(atom: Node): Node {
    this.skipExtended()
    let min: number
    let max: number
    const cp = this.peek()
    if (cp === 0x2a) {
      min = 0
      max = Number.POSITIVE_INFINITY
      this.pos += 1
    } else if (cp === 0x2b) {
      min = 1
      max = Number.POSITIVE_INFINITY
      this.pos += 1
    } else if (cp === 0x3f) {
      min = 0
      max = 1
      this.pos += 1
    } else if (cp === 0x7b) {
      const counted = this.tryCounted()
      if (counted === undefined) return atom
      ;[min, max] = counted
    } else {
      return atom
    }
    if (atom.k === "assert") syntax("quantifier after an assertion")
    if (this.eat(0x2b)) unsupported("with a possessive quantifier")
    this.eat(0x3f)
    const next = this.peek()
    if (next === 0x2a || next === 0x2b || next === 0x3f) syntax("nested quantifier")
    return { k: "rep", node: atom, min, max }
  }

  private tryCounted(): [number, number] | undefined {
    const start = this.pos
    this.pos += 1
    const readInt = (): number | undefined => {
      let digits = ""
      while (this.peek() !== undefined && isDigit(this.peek() ?? 0)) {
        digits += String.fromCodePoint(this.peek() ?? 0)
        this.pos += 1
      }
      return digits === "" ? undefined : Number.parseInt(digits, 10)
    }
    const min = readInt()
    let max = min
    if (min !== undefined && this.eat(0x2c)) {
      max = readInt() ?? Number.POSITIVE_INFINITY
    }
    if (min === undefined || !this.eat(0x7d)) {
      this.pos = start
      return undefined
    }
    if (max === undefined) max = min
    if (min > REGEX_LIMITS.maxRepeat || (Number.isFinite(max) && max > REGEX_LIMITS.maxRepeat)) {
      unsupported(`with a repetition count above ${REGEX_LIMITS.maxRepeat}`)
    }
    if (max < min) syntax("numbers out of order in a {} quantifier")
    return [min, max]
  }

  private literal(cp: number): Node {
    const test: CharTest = (c) => c === cp
    return { k: "char", test: this.flags.i ? caseless(test) : test }
  }

  private charNode(test: CharTest): Node {
    return { k: "char", test: this.flags.i ? caseless(test) : test }
  }

  private parseAtom(): Node | undefined {
    const cp = this.peek()
    if (cp === undefined) return undefined
    this.pos += 1
    switch (cp) {
      case 0x2e: {
        const dotAll = this.flags.s
        return { k: "char", test: dotAll ? () => true : (c) => c !== 0x0a }
      }
      case 0x5e:
        return { k: "assert", kind: "bol", multiline: this.flags.m }
      case 0x24:
        return { k: "assert", kind: "eol", multiline: this.flags.m }
      case 0x28:
        return this.parseGroup()
      case 0x5b:
        return this.charNode(this.parseClass())
      case 0x5c:
        return this.parseEscape()
      case 0x2a:
      case 0x2b:
      case 0x3f:
        return syntax("quantifier does not follow a repeatable item")
      default:
        return this.literal(cp)
    }
  }

  private parseGroup(): Node | undefined {
    if (this.eat(0x3f)) {
      const cp = this.peek()
      if (cp === 0x3a) {
        this.pos += 1
        return this.groupBody()
      }
      if (cp === 0x3d || cp === 0x21) unsupported("with lookahead")
      if (cp === 0x3e) unsupported("with an atomic group")
      if (cp === 0x28) unsupported("with a conditional group")
      if (cp === 0x52 || cp === 0x26 || (cp !== undefined && isDigit(cp)))
        unsupported("with recursion")
      if (cp === 0x3c) {
        const next = this.peek(1)
        if (next === 0x3d || next === 0x21) unsupported("with lookbehind")
        this.pos += 1
        this.skipName(0x3e)
        return this.groupBody()
      }
      if (cp === 0x50) {
        const next = this.peek(1)
        if (next === 0x3c) {
          this.pos += 2
          this.skipName(0x3e)
          return this.groupBody()
        }
        unsupported("with a named backreference")
      }
      if (cp === 0x27) {
        this.pos += 1
        this.skipName(0x27)
        return this.groupBody()
      }
      if (cp === 0x23) {
        while (this.peek() !== undefined && this.peek() !== 0x29) this.pos += 1
        if (!this.eat(0x29)) syntax("missing ) after a comment")
        return undefined
      }
      return this.parseInlineFlags()
    }
    return this.groupBody()
  }

  private skipName(terminator: number): void {
    let length = 0
    while (this.peek() !== undefined && this.peek() !== terminator) {
      if (!isWordChar(this.peek() ?? 0)) syntax("invalid group name")
      this.pos += 1
      length += 1
    }
    if (length === 0 || !this.eat(terminator)) syntax("invalid group name")
  }

  private groupBody(): Node {
    const saved = { ...this.flags }
    const node = this.parseAlt()
    this.flags = saved
    if (!this.eat(0x29)) syntax("missing )")
    return node
  }

  private parseInlineFlags(): Node | undefined {
    let on = true
    const next: Flags = { ...this.flags }
    for (;;) {
      const cp = this.peek()
      if (cp === undefined) syntax("missing ) after inline flags")
      this.pos += 1
      if (cp === 0x29) {
        this.flags = next
        return undefined
      }
      if (cp === 0x3a) {
        const saved = this.flags
        this.flags = next
        const node = this.parseAlt()
        this.flags = saved
        if (!this.eat(0x29)) syntax("missing )")
        return node
      }
      if (cp === 0x2d) {
        on = false
        continue
      }
      const letter = String.fromCodePoint(cp ?? 0)
      if (letter === "i" || letter === "m" || letter === "s" || letter === "x") {
        next[letter] = on
      } else {
        unsupported(`with the inline option (?${letter})`)
      }
    }
  }

  private parseEscape(): Node | undefined {
    const cp = this.peek()
    if (cp === undefined) syntax("\\ at end of pattern")
    const letter = String.fromCodePoint(cp)
    switch (letter) {
      case "b":
        this.pos += 1
        return { k: "assert", kind: "word", multiline: false }
      case "B":
        this.pos += 1
        return { k: "assert", kind: "nonword", multiline: false }
      case "A":
        this.pos += 1
        return { k: "assert", kind: "start", multiline: false }
      case "z":
        this.pos += 1
        return { k: "assert", kind: "end", multiline: false }
      case "Z":
        this.pos += 1
        return { k: "assert", kind: "endz", multiline: false }
      case "G":
      case "K":
        return unsupported(`with \\${letter}`)
      case "Q":
        return unsupported("with \\Q quoting")
      default: {
        const test = this.parseClassEscape(true)
        return this.charNode(test)
      }
    }
  }

  private parseClassEscape(outsideClass: boolean): CharTest {
    const cp = this.peek()
    if (cp === undefined) syntax("\\ at end of pattern")
    this.pos += 1
    const letter = String.fromCodePoint(cp)
    switch (letter) {
      case "d":
        return isDigit
      case "D":
        return (c) => !isDigit(c)
      case "w":
        return isWordChar
      case "W":
        return (c) => !isWordChar(c)
      case "s":
        return isSpace
      case "S":
        return (c) => !isSpace(c)
      case "h":
        return isHorizontalSpace
      case "H":
        return (c) => !isHorizontalSpace(c)
      case "v":
        return isVerticalSpace
      case "V":
        return (c) => !isVerticalSpace(c)
      case "t":
        return (c) => c === 0x09
      case "n":
        return (c) => c === 0x0a
      case "r":
        return (c) => c === 0x0d
      case "f":
        return (c) => c === 0x0c
      case "e":
        return (c) => c === 0x1b
      case "a":
        return (c) => c === 0x07
      case "x": {
        const value = this.parseHex()
        return (c) => c === value
      }
      case "c": {
        const next = this.peek()
        if (next === undefined) syntax("\\c at end of pattern")
        this.pos += 1
        const value = String.fromCodePoint(next).toUpperCase().codePointAt(0) ?? 0
        const control = value ^ 0x40
        return (c) => c === control
      }
      case "0": {
        let value = 0
        for (let count = 0; count < 2 && isOctal(this.peek()); count += 1) {
          value = value * 8 + ((this.peek() ?? 0x30) - 0x30)
          this.pos += 1
        }
        return (c) => c === value
      }
      case "p":
      case "P":
        return unsupported("with Unicode property classes")
      case "R":
      case "X":
        return unsupported(`with \\${letter}`)
      case "g":
      case "k":
        return unsupported("with a backreference")
      case "u":
      case "U":
      case "N":
      case "C":
        return unsupported(`with \\${letter}`)
      default:
        if (isDigit(cp)) {
          return outsideClass
            ? unsupported("with a backreference")
            : unsupported("with an octal escape")
        }
        if (isWordChar(cp)) syntax(`unrecognized escape \\${letter}`)
        return (c) => c === cp
    }
  }

  private parseHex(): number {
    if (this.eat(0x7b)) {
      let digits = ""
      while (this.peek() !== undefined && this.peek() !== 0x7d) {
        digits += String.fromCodePoint(this.peek() ?? 0)
        this.pos += 1
      }
      if (!this.eat(0x7d) || !/^[0-9a-fA-F]{1,6}$/.test(digits)) syntax("invalid \\x{} escape")
      const value = Number.parseInt(digits, 16)
      if (value > 0x10ffff) syntax("code point out of range")
      return value
    }
    let digits = ""
    for (let count = 0; count < 2; count += 1) {
      const cp = this.peek()
      if (cp === undefined || !/[0-9a-fA-F]/.test(String.fromCodePoint(cp))) break
      digits += String.fromCodePoint(cp)
      this.pos += 1
    }
    return digits === "" ? 0 : Number.parseInt(digits, 16)
  }

  private parseClass(): CharTest {
    const negate = this.eat(0x5e)
    const tests: CharTest[] = []
    let first = true
    for (;;) {
      const cp = this.peek()
      if (cp === undefined) syntax("missing terminating ] for a character class")
      if (cp === 0x5d && !first) {
        this.pos += 1
        break
      }
      first = false
      if (cp === 0x5b && this.peek(1) === 0x3a) {
        tests.push(this.parsePosix())
        continue
      }
      const low = this.parseClassAtom()
      if (this.peek() === 0x2d && this.peek(1) !== 0x5d && this.peek(1) !== undefined) {
        if (typeof low !== "number") {
          tests.push(low)
          continue
        }
        this.pos += 1
        const high = this.parseClassAtom()
        if (typeof high !== "number") syntax("invalid range in a character class")
        if (high < low) syntax("range out of order in a character class")
        tests.push((c) => c >= low && c <= high)
        continue
      }
      if (typeof low === "number") tests.push((c) => c === low)
      else tests.push(low)
    }
    const union: CharTest = (c) => tests.some((test) => test(c))
    const matcher = this.flags.i ? caseless(union) : union
    return negate ? (c) => !matcher(c) : matcher
  }

  private parseClassAtom(): number | CharTest {
    const cp = this.peek()
    if (cp === undefined) syntax("missing terminating ]")
    this.pos += 1
    if (cp !== 0x5c) return cp
    const next = this.peek()
    if (next === undefined) syntax("\\ at end of pattern")
    if (next === 0x62) {
      this.pos += 1
      return 0x08
    }
    const singles: Readonly<Record<string, number>> = {
      t: 0x09,
      n: 0x0a,
      r: 0x0d,
      f: 0x0c,
      e: 0x1b,
      a: 0x07,
    }
    const single = singles[String.fromCodePoint(next)]
    if (single !== undefined) {
      this.pos += 1
      return single
    }
    if (next === 0x78) {
      this.pos += 1
      return this.parseHex()
    }
    if (!isWordChar(next)) {
      this.pos += 1
      return next
    }
    return this.parseClassEscape(false)
  }

  private parsePosix(): CharTest {
    this.pos += 2
    const negate = this.eat(0x5e)
    let name = ""
    while (this.peek() !== undefined && this.peek() !== 0x3a) {
      name += String.fromCodePoint(this.peek() ?? 0)
      this.pos += 1
    }
    if (!this.eat(0x3a) || !this.eat(0x5d)) syntax("invalid POSIX class")
    const test = POSIX[name]
    if (test === undefined) syntax(`unknown POSIX class ${name}`)
    return negate ? (c) => !test(c) : test
  }
}

function isOctal(cp: number | undefined): boolean {
  return cp !== undefined && cp >= 0x30 && cp <= 0x37
}

class Compiler {
  readonly program: Inst[] = []

  emit(inst: Inst): number {
    if (this.program.length >= REGEX_LIMITS.maxProgram) {
      unsupported(`larger than ${REGEX_LIMITS.maxProgram} instructions`)
    }
    this.program.push(inst)
    return this.program.length - 1
  }

  compile(node: Node): void {
    switch (node.k) {
      case "char":
        this.emit({ op: "char", test: node.test })
        return
      case "assert":
        this.emit({ op: "assert", kind: node.kind, multiline: node.multiline })
        return
      case "seq":
        for (const item of node.items) this.compile(item)
        return
      case "alt": {
        const jumps: number[] = []
        node.items.forEach((item, index) => {
          if (index < node.items.length - 1) {
            const split = this.emit({ op: "split", x: 0, y: 0 })
            this.patchSplit(split, this.program.length, -1)
            this.compile(item)
            jumps.push(this.emit({ op: "jmp", x: 0 }))
            this.patchSplit(split, -1, this.program.length)
          } else {
            this.compile(item)
          }
        })
        for (const jump of jumps) this.patchJump(jump, this.program.length)
        return
      }
      case "rep": {
        for (let count = 0; count < node.min; count += 1) this.compile(node.node)
        if (node.max === Number.POSITIVE_INFINITY) {
          const split = this.emit({ op: "split", x: 0, y: 0 })
          this.patchSplit(split, this.program.length, -1)
          this.compile(node.node)
          this.emit({ op: "jmp", x: split })
          this.patchSplit(split, -1, this.program.length)
          return
        }
        const splits: number[] = []
        for (let count = node.min; count < node.max; count += 1) {
          const split = this.emit({ op: "split", x: 0, y: 0 })
          this.patchSplit(split, this.program.length, -1)
          splits.push(split)
          this.compile(node.node)
        }
        for (const split of splits) this.patchSplit(split, -1, this.program.length)
        return
      }
    }
  }

  private patchSplit(at: number, x: number, y: number): void {
    const inst = this.program[at]
    if (inst?.op !== "split") return
    if (x >= 0) inst.x = x
    if (y >= 0) inst.y = y
  }

  private patchJump(at: number, x: number): void {
    const inst = this.program[at]
    if (inst?.op === "jmp") inst.x = x
  }
}

/** A compiled regular expression that matches in time linear in the input length. */
export interface LinearRegex {
  readonly pattern: string
  readonly options: string
  /** Returns true when the pattern matches anywhere in `input`. */
  test(input: string): boolean
}

function parseOptions(options: string): Flags {
  const flags: Flags = { i: false, m: false, s: false, x: false }
  for (const letter of options) {
    if (letter === "i" || letter === "m" || letter === "s" || letter === "x") flags[letter] = true
    else if (letter !== "u") syntax(`unknown option ${letter}`)
  }
  return flags
}

/**
 * Compiles a MongoDB regular expression for in-process matching. Throws {@link InvalidQueryError} for invalid
 * patterns and for patterns that a linear time engine cannot run.
 */
export function compileRegex(pattern: string, options = ""): LinearRegex {
  if (pattern.length > REGEX_LIMITS.maxPatternLength) {
    throw new InvalidQueryError(
      `Regular expression longer than ${REGEX_LIMITS.maxPatternLength} characters`,
    )
  }
  if (pattern.includes("\0")) syntax("NUL character in pattern")
  const flags = parseOptions(options)
  const ast = new Parser(pattern, flags).parse()
  const literal = flags.i || flags.x ? null : LITERAL.exec(pattern)
  if (literal !== null) {
    const text = literal[2] ?? ""
    const test =
      literal[1] === "^" && !flags.m
        ? (input: string) => input.startsWith(text)
        : literal[1] === ""
          ? (input: string) => input.includes(text)
          : undefined
    if (test !== undefined) return { pattern, options, test }
  }
  const compiler = new Compiler()
  compiler.compile(ast)
  compiler.emit({ op: "match" })
  const machine = new Machine(compiler.program)
  return {
    pattern,
    options,
    test: (input: string) => machine.run(input),
  }
}

/**
 * A pattern that is plain text, optionally anchored with `^`: letters, digits and punctuation without a
 * meaning in a regular expression. Without the `i` and `x` options it matches exactly the strings that
 * contain the text (or start with it), so it is tested as a substring.
 */
const LITERAL = /^(\^?)([A-Za-z0-9 _,;:!@%&=~<>/'"-]+)$/

/** Returns true when `pattern` compiles under the linear time engine. */
export function isLinearRegex(pattern: string, options = ""): boolean {
  try {
    compileRegex(pattern, options)
    return true
  } catch (error: unknown) {
    if (error instanceof CanopyError && error.code === ErrorCode.InvalidQuery) return false
    throw error
  }
}

function checkAssert(
  kind: AssertKind,
  multiline: boolean,
  cps: readonly number[],
  at: number,
): boolean {
  const length = cps.length
  switch (kind) {
    case "bol":
      return at === 0 || (multiline && cps[at - 1] === 0x0a)
    case "eol":
      if (multiline) return at === length || cps[at] === 0x0a
      return at === length || (at === length - 1 && cps[at] === 0x0a)
    case "start":
      return at === 0
    case "end":
      return at === length
    case "endz":
      return at === length || (at === length - 1 && cps[at] === 0x0a)
    case "word":
    case "nonword": {
      const before = at > 0 && isWordChar(cps[at - 1] ?? 0)
      const after = at < length && isWordChar(cps[at] ?? 0)
      return kind === "word" ? before !== after : before === after
    }
  }
}

/** Stamps start over below this, so they stay within `Int32Array` range. */
const MAX_STAMP = 0x3fffffff

/**
 * Runs one compiled program. It keeps its thread lists between matches, and a program that can only match
 * at the start of the input (it begins with `^` outside multiline mode, or `\A`) starts a thread at the
 * first position only and stops as soon as no thread is left.
 */
class Machine {
  private readonly program: readonly Inst[]
  private readonly anchored: boolean
  private current: Int32Array
  private next: Int32Array
  /** Per instruction, the stamp of the step that last added it: `base + position`. */
  private readonly seen: Int32Array
  private base = 0
  private readonly stack: number[] = []
  private readonly cps: number[] = []
  private running = false

  constructor(program: readonly Inst[]) {
    this.program = program
    const first = program[0]
    this.anchored =
      first?.op === "assert" &&
      (first.kind === "start" || (first.kind === "bol" && !first.multiline))
    this.current = new Int32Array(program.length)
    this.next = new Int32Array(program.length)
    this.seen = new Int32Array(program.length).fill(-1)
  }

  run(input: string): boolean {
    if (this.running) return new Machine(this.program).run(input)
    this.running = true
    try {
      return this.match(input)
    } finally {
      this.running = false
    }
  }

  private match(input: string): boolean {
    const { program, cps } = this
    cps.length = 0
    for (const char of input) cps.push(char.codePointAt(0) ?? 0)
    if ((cps.length + 1) * program.length > REGEX_LIMITS.maxSteps) {
      throw new CanopyError(
        ErrorCode.Timeout,
        "Regular expression input is too large to match in process",
      )
    }
    if (this.base + cps.length + 2 > MAX_STAMP) {
      this.seen.fill(-1)
      this.base = 0
    }
    const base = this.base
    this.base += cps.length + 2
    let current = this.current
    let next = this.next
    let currentCount = 0
    for (let at = 0; at <= cps.length; at += 1) {
      if (at === 0 || !this.anchored)
        currentCount = this.add(current, currentCount, 0, at, base + at)
      else if (currentCount === 0) return false
      let nextCount = 0
      const cp = cps[at]
      for (let index = 0; index < currentCount; index += 1) {
        const inst = program[current[index] ?? 0]
        if (inst === undefined) continue
        if (inst.op === "match") return true
        if (inst.op === "char" && cp !== undefined && inst.test(cp)) {
          nextCount = this.add(next, nextCount, (current[index] ?? 0) + 1, at + 1, base + at + 1)
        }
      }
      const swap = current
      current = next
      next = swap
      currentCount = nextCount
    }
    return false
  }

  private add(list: Int32Array, count: number, start: number, at: number, stamp: number): number {
    const { program, seen, stack, cps } = this
    stack.length = 0
    stack.push(start)
    let added = count
    while (stack.length > 0) {
      const pc = stack.pop() ?? 0
      if (seen[pc] === stamp) continue
      seen[pc] = stamp
      const inst = program[pc]
      if (inst === undefined) continue
      switch (inst.op) {
        case "jmp":
          stack.push(inst.x)
          break
        case "split":
          stack.push(inst.y, inst.x)
          break
        case "assert":
          if (checkAssert(inst.kind, inst.multiline, cps, at)) stack.push(pc + 1)
          break
        default:
          list[added] = pc
          added += 1
      }
    }
    return added
  }
}
