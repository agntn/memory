import { fileURLToPath } from "node:url";
import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so the entries share one core instead of each shipping its own. */
      type: "bundle",
      input: ["./src/index.ts", "./src/cli.ts", "./src/mcp.ts", "./src/ai.ts"],
      rolldown: {
        /** A deployed Worker has no `import.meta.url` to probe a checkout with. */
        transform: { define: { "import.meta.bundled": "true" } },
        resolve: {
          /** The executors load the package by name, and in here that name is the root entry. */
          alias: { "@agntn/memory": fileURLToPath(new URL("src/index.ts", import.meta.url)) },
        },
      },
    },
  ],
});
