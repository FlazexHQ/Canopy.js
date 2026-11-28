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

## Verify an email address after sign up

When email verification is enabled (the default), Canopy emails a link after password sign up.
In cookie mode, open the link in the same browser profile that signed up. The browser sends the
sign up proof cookie, so Canopy keeps the password chosen at sign up.

In bearer mode, use `sendVerificationOtp({ email })` to email a verification code, then call
`verifyEmailWithOtp({ email, otp })` to verify the address and sign in. Use the auth instance that
signed up, or configure the same auth storage across reloads. The SDK sends the sign up proof
with the code so Canopy keeps the password chosen at sign up.

If the link is opened in another browser or device, or the account was created in bearer mode,
Canopy verifies the address, removes the original password and ends the account's existing
sessions. The user must reset their password before signing in with a password again.

## Two factor sign in

`signInWithPassword` and `signInWithOtp` reject with an `AuthError` whose code is
`TWO_FACTOR_REQUIRED` when the user needs a second factor. Read `error.twoFactorMethods` for the
available methods, then call `verifyTotp` or `verifyBackupCode` on the same auth instance. The SDK
carries the ceremony header from the first response into verification.

After an OAuth or OIDC redirect or a magic link, call `completeRedirect()` on the callback page.
If Canopy requests a second factor, the method removes the ceremony parameters from the URL and
rejects with the same error. Keep the auth instance for verification. In bearer mode, the SDK
includes cookies on that verification request and uses the resulting bearer session for token
requests.

For a callback page on a different origin, add the app's exact origin to Canopy's
`auth.trustedOrigins`.
The auth router returns `Access-Control-Allow-Credentials: true` and the matching
`Access-Control-Allow-Origin` for trusted origins. The callback page and auth endpoint must also
be same site so the browser can send the `SameSite=Lax` ceremony cookie on the verification
request.

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
bun run check          # lint, format check, core layout and artifact checks, typecheck and tests
bun run build          # dist/ for every entry point
bun run test           # Vitest: client, React, Vue, Svelte, Solid, TanStack DB and devtools
bun run test:browser   # the client and binding suites in Chromium, Firefox and WebKit
bun run format         # bun fmt
```

`src/core` contains the wire protocol and generated Rust bindings. Refresh the artifacts with
`bun run sync:wasm`. The protocol and authoring fixtures in `test/vectors` are snapshots of Canopy's
conformance vectors. Update the relevant snapshots when Canopy changes them.

Use `canopy.js/config`, `canopy.js/policy` and `canopy.js/schema` to declare project inputs.
`canopy.js/emit` validates those inputs with the Rust authoring module. Use the Canopy CLI to
resolve configuration and run policy tests. REST aggregation accepts a Standard Schema decoder
supplied by the caller.

Canopy itself depends on canopy.js (Studio, GraphQL subscriptions and its end to end tests). After a change
here, run `bun run build`, then `bun install` in Canopy.
