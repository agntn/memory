import { registerOmpTools, type OmpRenderers } from "@agntn/tools/omp";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-tui";
import {
  createMemoryTools,
  hostSessionId,
  type MemoryToolName,
  scopedCallArguments,
} from "../shared/memory-tool-definitions.ts";
import { configuredMemoryScope } from "../shared/memory-scope.ts";
import type { ProfileParams } from "../shared/memory-tools.types.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../shared/tui.ts";
import {
  describeToolCall,
  MEMORY_TOOL_SYMBOLS,
  renderStatusLine,
  renderToolResult,
} from "../shared/tui.ts";
import { memoryToolMeta } from "../shared/memory-tool-contract.ts";

/* OMP keeps the failure flag in the result object it hands the renderer. */
function resultLine(result: RenderedToolResult, options: RenderOptions, theme: StatusTheme) {
  return new Text(renderToolResult(result, result.isError ?? false, options, theme), 0, 0);
}

/**
 * OMP calls the call renderer with `(args, options, theme)`. Scoped tools show the scope they hide.
 *
 * @param name - Tool the renderers draw.
 * @param scope - Namespace and profile the host fixes, if any.
 * @returns {OmpRenderers} Call and result renderers for the tool.
 */
function renderers(name: MemoryToolName, scope: ProfileParams | undefined): OmpRenderers {
  return {
    renderCall: (args: unknown, options: RenderOptions, theme: StatusTheme) =>
      new Text(
        renderStatusLine(
          describeToolCall(
            memoryToolMeta[name].label,
            scopedCallArguments(name, args as object, scope),
            options,
            MEMORY_TOOL_SYMBOLS[name],
          ),
          theme,
        ),
        0,
        0,
      ),
    renderResult: resultLine,
  };
}

export default function memoryExtension(omp: ExtensionAPI) {
  omp.setLabel("Memory");
  const scope = configuredMemoryScope();
  const tools = createMemoryTools({ scope, writeSession: (host) => hostSessionId("omp", host) });
  registerOmpTools(omp, tools, {
    Text,
    renderers: Object.fromEntries(
      tools.map((tool) => [tool.name, renderers(tool.name as MemoryToolName, scope)]),
    ),
  });
}
