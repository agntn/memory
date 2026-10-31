import { registerPiTools, type PiRenderers } from "@agntn/tools/pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createMemoryTools,
  hostSessionId,
  type MemoryToolName,
  scopedCallArguments,
} from "../shared/memory-tool-definitions.ts";
import { configuredPiMemoryScope } from "../shared/memory-scope.ts";
import type { ProfileParams } from "../shared/memory-tools.types.ts";
import type { RenderedToolResult, RenderOptions, StatusTheme } from "../shared/tui.ts";
import {
  describeToolCall,
  MEMORY_TOOL_SYMBOLS,
  renderStatusLine,
  renderToolResult,
} from "../shared/tui.ts";
import { memoryToolMeta } from "../shared/memory-tool-contract.ts";

/*
 * Render a finished call.
 *
 * Pi orders the renderer arguments `(result, options, theme, context)` and
 * reports a failure in the context. Its result object never carries the flag.
 */
function resultLine(
  result: RenderedToolResult,
  options: RenderOptions,
  theme: StatusTheme,
  context?: Readonly<{ isError?: boolean }>,
) {
  return new Text(renderToolResult(result, context?.isError ?? false, options, theme), 0, 0);
}

/**
 * Pi calls the call renderer with `(args, theme, context)`. Unscoped calls show the default.
 *
 * @param name - Tool the renderers draw.
 * @param scope - Namespace and profile the host defaults to, if any.
 * @returns {PiRenderers} Call and result renderers for the tool.
 */
function renderers(name: MemoryToolName, scope: ProfileParams | undefined): PiRenderers {
  return {
    renderCall: (args: unknown, theme: StatusTheme, context?: RenderOptions) =>
      new Text(
        renderStatusLine(
          describeToolCall(
            memoryToolMeta[name].label,
            scopedCallArguments(name, args as object, scope),
            context,
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

export default function memoryExtension(pi: ExtensionAPI) {
  const scope = configuredPiMemoryScope();
  const tools = createMemoryTools({ scope, writeSession: (host) => hostSessionId("pi", host) });
  registerPiTools(pi, tools, {
    renderers: Object.fromEntries(
      tools.map((tool) => [tool.name, renderers(tool.name as MemoryToolName, scope)]),
    ),
  });
}
