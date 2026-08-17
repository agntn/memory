import { defineBuildConfig } from "obuild/config";

export default defineBuildConfig({
  declaration: true,
  rollup: { emitCJS: false },
  entries: ["src/index", "src/cli", "src/mcp"],
});
