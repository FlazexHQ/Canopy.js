# Canopy Chat

A Next.js and React 19 example with one shared room, built on canopy.js. Members register with an email address and password. The room subscribes to the latest 100 messages. Document policies allow authenticated members to read messages and require each new message to carry its sender's user ID.

## Run locally

Clone [Canopy](https://github.com/FlazexHQ/Canopy) next to Canopy.js (the stack builds its images from there until they are published). From the Canopy.js root, run `bun install --frozen-lockfile` and `bun run build`. Then run these commands from `examples/chatapp`:

```sh
node -e "require('node:fs').writeFileSync('.env','CANOPY_MASTER_KEY='+require('node:crypto').randomBytes(32).toString('base64url')+'\n',{flag:'wx'})"
docker compose up -d --build --wait
bun run build
bun run start --hostname localhost
```

Generate the key once and keep it with the local deployment. Open [Canopy Chat](http://localhost:3000). Register a second account in a private browser window to try realtime delivery.

The Compose project runs Canopy as separate containers: `database` (a single member MongoDB replica set), `api` (REST, GraphQL, email and password auth, private file storage and the admin API), `realtime` (live queries and messages), `studio` and `edge`, the one entry on <http://localhost:8080>. If one of them stops, the others keep working, and the edge answers `503` only for the routes of the stopped service. The app's config (`canopy.config.ts`) and policies (`policies/`) are mounted into `api` and `realtime`; both import from canopy.js. [Studio](http://localhost:8080/studio/) uses a separate administrator account: the initial setup token appears in `docker compose logs api`. Metrics are on loopback ports 9464 (api) and 9465 (realtime). Database and file contents persist in named volumes.

Run `bun run e2e:install` and `bun run e2e` while the stack and the app are running to test two accounts, live delivery, sign out and session restoration. The test creates accounts and a message in this local room. Stop the backend with `docker compose down`.
