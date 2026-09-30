import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    // The Worker has its own install and suite: `pnpm --dir worker test`.
    exclude: [...configDefaults.exclude, "worker/**"],
  },
});
