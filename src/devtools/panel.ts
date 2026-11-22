import type { CanopyClient, Schema, StaleMutation } from "../client/index.ts"
import { type Frame, framesOf, type WarningOptions, watchMistakes } from "./warnings.ts"

/** One entry of the protocol log. */
export interface LogEntry {
  readonly at: number
  readonly direction: "in" | "out"
  readonly type: string
  readonly seq: number | undefined
  readonly ct: string | undefined
  readonly text: string
}

/** Options of {@link attachDevtools}. */
export interface DevtoolsOptions {
  /** Where the panel is added. Defaults to `document.body`. */
  readonly parent?: HTMLElement
  /** Opens the panel at once. Defaults to `false`: only the toggle button shows. */
  readonly open?: boolean
  /** How many frames the protocol log keeps. Defaults to 200. */
  readonly logSize?: number
  /** Development warnings; `false` turns them off. Defaults to on. */
  readonly warnings?: WarningOptions | false
}

/** A mounted devtools panel. */
export interface Devtools {
  open(): void
  close(): void
  /** The protocol log, newest last. */
  readonly log: readonly LogEntry[]
  /** Renders the panel again from the client's current state. */
  refresh(): void
  /** Removes the panel and stops listening. */
  destroy(): void
}

const TABS = ["Connection", "Subscriptions", "Store", "Mutations", "Log"] as const
type Tab = (typeof TABS)[number]

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; label?: string; className?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.text !== undefined) node.textContent = props.text
  if (props.label !== undefined) node.setAttribute("aria-label", props.label)
  if (props.className !== undefined) node.className = props.className
  for (const child of children) node.append(child)
  return node
}

function table(
  headers: readonly string[],
  rows: readonly (readonly (string | Node)[])[],
): HTMLElement {
  const head = element("tr", {}, ...headers.map((header) => element("th", { text: header })))
  const body = rows.map((row) =>
    element(
      "tr",
      {},
      ...row.map((cell) =>
        typeof cell === "string" ? element("td", { text: cell }) : element("td", {}, cell),
      ),
    ),
  )
  const node = element("table", {}, element("thead", {}, head), element("tbody", {}, ...body))
  Object.assign(node.style, { borderCollapse: "collapse", width: "100%" })
  return node
}

const REDACTED = "[redacted]"

/** Hides the credentials a frame carries: user tokens and secret keys. */
function redact(frame: Frame): Frame {
  const copy: Record<string, unknown> = { ...frame }
  if (typeof copy["token"] === "string" && copy["token"] !== "") copy["token"] = REDACTED
  if (typeof copy["key"] === "string" && copy["key"].startsWith("canopy_sk_"))
    copy["key"] = REDACTED
  return copy
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Mounts the Canopy devtools in the page: a toggle button and a panel with the connection and transport,
 * the subscriptions with their status and document counts, the documents each subscription holds, the
 * pending mutations (discard) and stale ones (retry or discard), and a protocol log with `seq` and `ct`.
 * Development warnings are printed to the console. Built from DOM APIs only, so it works under a strict
 * CSP and with any framework.
 */
export function attachDevtools<DB extends Schema<DB>>(
  typed: CanopyClient<DB>,
  options: DevtoolsOptions = {},
): Devtools {
  const client = typed as unknown as CanopyClient
  const parent = options.parent ?? document.body
  const logSize = options.logSize ?? 200
  const log: LogEntry[] = []
  let opened = options.open === true
  let tab: Tab = "Connection"
  const root = element("div", { className: "canopy-devtools" })
  root.dataset["canopyDevtools"] = ""
  Object.assign(root.style, {
    position: "fixed",
    right: "12px",
    bottom: "12px",
    zIndex: "2147483647",
    font: "12px/1.4 ui-monospace, monospace",
    color: "#111",
  })
  const toggle = element("button", { text: "Canopy", label: "Toggle Canopy devtools" })
  toggle.type = "button"
  const panel = element("section", { label: "Canopy devtools" })
  Object.assign(panel.style, {
    background: "#fff",
    border: "1px solid #ccc",
    borderRadius: "6px",
    width: "min(720px, 90vw)",
    maxHeight: "60vh",
    overflow: "auto",
    padding: "8px",
    marginBottom: "6px",
  })
  const nav = element("nav", { label: "Devtools sections" })
  const content = element("div")
  panel.append(nav, content)
  root.append(panel, toggle)
  parent.append(root)

  const tabButton = (name: Tab): HTMLButtonElement => {
    const button = element("button", { text: name })
    button.type = "button"
    button.setAttribute("aria-pressed", String(name === tab))
    button.addEventListener("click", () => {
      tab = name
      render()
    })
    return button
  }

  const action = (text: string, label: string, run: () => void): HTMLButtonElement => {
    const button = element("button", { text, label })
    button.type = "button"
    button.addEventListener("click", () => {
      run()
      render()
    })
    return button
  }

  const sections: Record<Tab, () => Node> = {
    Connection: () => {
      const internals = client.devtools()
      return table(
        ["Field", "Value"],
        [
          ["Status", client.connectionStatus],
          ["Transport", internals.rung === 0 ? "WebSocket" : `fallback ${internals.rung}`],
          ["Session", internals.sid ?? "none"],
          ["Subscriptions", String(internals.subscriptions.size)],
          ["Pending mutations", String(client.pendingMutations)],
          ["Cached documents", String(client.store.size)],
        ],
      )
    },
    Subscriptions: () =>
      table(
        ["ID", "Collection", "Query", "Status", "Documents"],
        [...client.devtools().subscriptions].map(([id, sub]) => {
          const state = client.store.state(id)
          return [id, sub.coll, json(sub.query), state.status, String(state.data.length)]
        }),
      ),
    Store: () =>
      element(
        "div",
        {},
        ...[...client.devtools().subscriptions].map(([id, sub]) =>
          element(
            "details",
            {},
            element("summary", { text: `${id} ${sub.coll} (${client.store.members(id).length})` }),
            element("pre", {
              text: client.store
                .members(id)
                .map((member) => `${json(member.doc)} @${member.ct}`)
                .join("\n"),
            }),
          ),
        ),
      ),
    Mutations: () => {
      const internals = client.devtools()
      const pending = table(
        ["Mutation", "Collection", "Operation", "Sent", ""],
        internals.outbox.map((entry) => [
          entry.message.id,
          entry.message.c,
          entry.message.op,
          entry.sent ? "yes" : "queued",
          action("Discard", `Discard ${entry.message.id}`, () =>
            internals.discard(entry.message.id),
          ),
        ]),
      )
      const stale = table(
        ["Stale mutation", "Collection", "Operation", "Created", ""],
        client.staleMutations.map((entry: StaleMutation) => [
          entry.mutationId,
          entry.collection,
          entry.op,
          new Date(entry.createdAt).toISOString(),
          element(
            "span",
            {},
            action("Retry", `Retry ${entry.mutationId}`, () => {
              entry.retry().catch(() => {})
            }),
            action("Discard", `Discard stale ${entry.mutationId}`, () => entry.discard()),
          ),
        ]),
      )
      return element("div", {}, pending, stale)
    },
    Log: () =>
      table(
        ["", "Type", "seq", "ct", "Frame"],
        [...log]
          .reverse()
          .map((entry) => [
            entry.direction === "in" ? "←" : "→",
            entry.type,
            entry.seq === undefined ? "" : String(entry.seq),
            entry.ct ?? "",
            entry.text.length > 160 ? `${entry.text.slice(0, 160)}…` : entry.text,
          ]),
      ),
  }

  function render(): void {
    panel.hidden = !opened
    toggle.setAttribute("aria-expanded", String(opened))
    if (!opened) return
    nav.replaceChildren(...TABS.map(tabButton))
    content.replaceChildren(sections[tab]())
  }

  toggle.addEventListener("click", () => {
    opened = !opened
    render()
  })

  const record = (direction: "in" | "out", text: string): void => {
    for (const frame of framesOf(text) as Frame[]) {
      log.push({
        at: Date.now(),
        direction,
        type: String(frame.t),
        seq: typeof frame.seq === "number" ? frame.seq : undefined,
        ct: typeof frame.ct === "string" ? frame.ct : undefined,
        text: json(redact(frame)),
      })
    }
    if (log.length > logSize) log.splice(0, log.length - logSize)
    if (opened) scheduleRender()
  }
  let scheduled = false
  const scheduleRender = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      render()
    })
  }
  const stops = [
    client.devtools().tap(record),
    client.onStatus(() => scheduleRender()),
    client.onStaleMutations(() => scheduleRender()),
    ...(options.warnings === false ? [] : [watchMistakes(client, options.warnings ?? {})]),
  ]
  render()

  return {
    log,
    open() {
      opened = true
      render()
    },
    close() {
      opened = false
      render()
    },
    refresh: render,
    destroy() {
      for (const stop of stops) stop()
      root.remove()
    },
  }
}
