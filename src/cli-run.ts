import { runCli } from "@agntn/tools/cli";
import { sanitizeLine } from "@agntn/tools";
import { hostMemoryFields, type MemoryFields } from "../extensions/shared/memory-fields.ts";
import { projectRepository } from "../extensions/shared/memory-project-scope.ts";
import { createMemoryTools } from "../extensions/shared/memory-tool-definitions.ts";
import {
  configuredMemoryScope,
  shellMemoryHarness,
  shellMemorySessionId,
} from "../extensions/shared/memory-scope.ts";
import type { ProfileParams } from "../extensions/shared/memory-tools.types.ts";
import { version } from "./version.ts";

/**
 * Runs one `memory` command line: a command per tool, bound the way the MCP server binds them.
 *
 * @param argv - The words after `memory`.
 * @returns {Promise<void>} Once the command has written its answer and set the exit code.
 */
export async function runMemoryCli(argv: readonly string[]): Promise<void> {
  let scope: ProfileParams | undefined;
  let fields: MemoryFields | undefined;
  try {
    scope = configuredMemoryScope();
    fields = hostMemoryFields(shellMemoryHarness() ?? "cli");
  } catch (error) {
    process.stderr.write(`${sanitizeLine(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
    return;
  }
  await runCli(
    {
      name: "memory",
      version,
      description: "Agent memory CLI",
      tools: createMemoryTools({
        scope,
        fields,
        repository: () => projectRepository(process.cwd()),
        writeSession: () => shellMemorySessionId(),
      }),
      mcp: { name: "memory", version },
      expected: (error) => error instanceof Error,
    },
    argv,
  );
}
