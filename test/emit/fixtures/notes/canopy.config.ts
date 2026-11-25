import { defineConfig, env } from "canopy.js/config"

export default defineConfig(({ mode, command }) => {
  // biome-ignore lint/suspicious/noConsole: the emitter must move project console output to stderr
  console.log(`evaluating the config for ${mode} ${command}`)
  return {
    mongodb: {
      uri: env("NOTES_MONGODB_URI", { default: "mongodb://localhost:27017/?replicaSet=rs0" }),
      database: "notes",
    },
    environment: mode,
    masterKey: env.secret("CANOPY_EMIT_CANARY"),
    log: { level: command === "dev" ? "debug" : "info" },
    policies: { dir: env("NOTES_POLICIES", { default: "./policies" }) },
  }
})
