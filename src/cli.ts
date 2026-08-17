#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { version } from "./version.ts";

const main = defineCommand({
  meta: {
    name: "memory",
    version,
    description: "Agent memory CLI",
  },
  subCommands: {
    mcp: () => import("./commands/mcp.ts").then((m) => m.default),
  },
});

await runMain(main);
