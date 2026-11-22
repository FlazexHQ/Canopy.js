import { builtin, defineConfig, env } from "canopy.js/config"

export default defineConfig({
  mongodb: { uri: "mongodb://database:27017/?replicaSet=rs0", database: "chat" },
  environment: "development",
  publicUrl: "http://localhost:8080",
  masterKey: env("CANOPY_MASTER_KEY"),
  auth: builtin({ emailPassword: { minPasswordLength: 10, requireEmailVerification: false } }),
  cors: { origins: ["http://localhost:3000", "http://localhost:8080"] },
  keys: { publishable: ["pk_chat_local"] },
  policies: { dir: "./policies" },
  rest: true,
  realtime: true,
  graphql: true,
  storage: { backend: { kind: "local", root: "/app/storage" }, buckets: { files: {} } },
  telemetry: { tracing: true },
  audit: { dataWrites: true },
  server: { metricsHost: "0.0.0.0" },
})
