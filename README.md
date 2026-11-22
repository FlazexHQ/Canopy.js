# canopy.js

The TypeScript library for [Canopy](https://github.com/FlazexHQ/Canopy), the open source, self hostable backend
platform for MongoDB. One package carries everything an app needs: the realtime client, the framework
bindings, devtools, and the DSLs for policies, schemas and the server config.

> **Canopy** is a working name. Nothing is published to npm yet and no license has been chosen: until then,
> use canopy.js from a clone of this repository.

```bash
bun add canopy.js      # or: pnpm add canopy.js, yarn add canopy.js, npm install canopy.js
```

| Import                     | What it gives you                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `canopy.js`                | The client: document cache, live queries, optimistic mutations, offline queue, reconnect and resume |
| `canopy.js/react`          | `CanopyProvider`, `useQuery`, `useCanopyStatus` and `createReactDb`                                 |
| `canopy.js/vue`            | `useQuery` returning `ShallowRef`s, `useMutation` and a plugin                                      |
| `canopy.js/svelte`         | Svelte 5 `createQuery`: a reactive object that is also a store                                      |
| `canopy.js/solid`          | `createQuery` with signals and a context                                                            |
| `canopy.js/tanstack-db`    | Canopy collections as TanStack DB collections, synced from live queries                             |
| `canopy.js/devtools`       | An in page panel for the connection, subscriptions, store and pending mutations                     |
| `canopy.js/auth`           | Sign up, sign in, sessions, MFA and passkeys against Canopy's built in auth                         |
| `canopy.js/rest`           | A typed client for the Data API (REST): pages, counts, aggregates, patches and batches              |
| `canopy.js/server`         | Server side helpers for server rendering and service role access                                    |
| `canopy.js/persist`        | IndexedDB persistence for the cache and the offline queue                                           |
| `canopy.js/policy`         | Document Level Security policies: `collection`, `allow`, `restrict`, `auth`, `ctx`, `now`           |
| `canopy.js/policy/testing` | `describePolicies` and `as`, to unit test policies without a server                                 |
| `canopy.js/schema`         | Schemas in code: `defineSchema`, `collection` and the `t` field builders                            |
| `canopy.js/config`         | The server config file: `defineConfig`, `env()`, `builtin()` and `external()`                       |
| `canopy.js/protocol`       | Error classes and codes, EJSON `parse` and `stringify`, BSON value types                            |

React, Vue, Svelte, Solid and TanStack DB are optional peer dependencies: install the one your app uses.
Everything else is built in, with no runtime dependencies.

## Use it

Run Canopy (see [Run Canopy](#run-canopy)), then:

```ts
import { createClient } from "canopy.js"

const canopy = createClient({ url: "http://localhost:8080", publishableKey: "pk_dev" })

canopy
  .from("todos")
  .find({ done: false })
  .sort({ createdAt: -1 })
  .subscribe(({ data, status }) => console.log(status, data))

await canopy.insert("todos", { title: "Write docs", done: false, createdAt: new Date() })
```

With React:

```tsx
import { CanopyProvider, useCanopy, useQuery } from "canopy.js/react"
import { useMemo } from "react"

function Todos() {
  const canopy = useCanopy()
  const query = useMemo(() => canopy.from("todos").find({ done: false }).limit(50), [canopy])
  const { data, status } = useQuery(query)
  if (status === "loading") return <p>Loading</p>
  return (
    <ul>
      {data.map((todo) => (
        <li key={String(todo["_id"])}>{String(todo["title"])}</li>
      ))}
    </ul>
  )
}

export function App() {
  return (
    <CanopyProvider client={canopy}>
      <Todos />
    </CanopyProvider>
  )
}
```

Policies, schemas and the server config are TypeScript files you keep in your app and mount into the Canopy
containers:

```ts
// canopy/policies/todos.ts
import { allow, auth, collection } from "canopy.js/policy"

export default collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})
```

## Run Canopy

Install Docker with Compose. In a project that has canopy.js installed, start the development stack with one command once the container images are published:

```bash
bun run canopy-stack up
```

The first `up` creates `canopy/` with a config, a starter policy, a Compose file, the edge config and a generated master key in `canopy/.env`. Run `bun run canopy-stack init` to review or edit those files before starting. Images default to the installed canopy.js version. Pass `--tag <tag>` to `init` or `up`, or set `CANOPY_VERSION` to choose another tag.

The images are currently unpublished. Clone Canopy and Canopy.js side by side, then build and start the stack from your project directory:

```bash
bun run canopy-stack up --build ../Canopy
```

Adjust the path to the Canopy checkout as needed. If the library checkout is elsewhere, pass `--canopy-js <path>`.

Open Studio at <http://localhost:8080/studio>. Use `bun run canopy-stack logs api` to read the first owner setup token, `bun run canopy-stack status` to check the services, and `bun run canopy-stack down` to stop them. See the [Canopy README](https://github.com/FlazexHQ/Canopy#run-canopy-as-containers) for the production stack.

## Examples

| Example                                | Shows                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| [`examples/chatapp`](examples/chatapp) | A Next.js chat room with built in auth, against the Canopy container stack |

## Develop

```bash
bun install --frozen-lockfile
bun run check          # lint, format check, core sync check, typecheck and tests
bun run build          # dist/ for every entry point
bun run test           # Vitest: client, React, Vue, Svelte, Solid, TanStack DB and devtools
bun run format         # bun fmt
bun run sync:core      # copy the universal core from ../Canopy (or CANOPY_REPO)
```

`src/core` is vendored from Canopy, which stays the source of truth for the wire protocol, the matcher, query
validation, policies, the config and the schema DSL (the server, the Rust core and the MongoDB differential
tests all live there). Never edit it here: change it in Canopy, then run `bun run sync:core`.
`bun run check:core` fails when the copy is out of date. The protocol conformance vectors in `test/vectors`
are vendored the same way.

Canopy itself depends on canopy.js (Studio, GraphQL subscriptions and its end to end tests). After a change
here, run `bun run build`, then `bun install` in Canopy.
