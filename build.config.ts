import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  declaration: true,
  rollup: { emitCJS: false },
  entries: ["src/index", "src/cli", "src/mcp"],
  hooks: {
    // typebox stays inline: resolving and parsing it from node_modules costs the
    // MCP server more at every spawn than the bundled copy does. obuild marks
    // every dependency and peer dependency external, so the entries the default
    // adds for typebox are filtered back out here.
    rolldownConfig(config) {
      const externals = Array.isArray(config.external) ? config.external : [];
      config.external = externals.filter(
        (entry) => entry !== "typebox" && !(entry instanceof RegExp && entry.test("typebox/value")),
      );
    },
  },
});
