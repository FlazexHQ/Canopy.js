import { defineProject } from "vitest/config"

export default defineProject({
  resolve: { conditions: ["canopy-js-source", "module", "browser", "development|production"] },
  test: { name: "chatapp", environment: "happy-dom", include: ["test/**/*.test.tsx"] },
})
