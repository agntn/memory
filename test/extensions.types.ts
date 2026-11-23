/** A theme that marks every color, so a test can see what got painted. */
export const painted = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bold: (text: string) => `<b>${text}`,
};

/** What a renderer returns: the mocked Text component keeps its string. */
export interface RenderedText {
  text: string;
}

export interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  approval?: string;
  /** Pi orders these `(args, theme, context)`, OMP `(args, options, theme)`. */
  renderCall?: (args: Record<string, unknown>, second?: unknown, third?: unknown) => RenderedText;
  /** Pi runs it on the raw model arguments before validation. */
  prepareArguments?: (args: unknown) => unknown;
  renderResult?: (
    result: unknown,
    options?: unknown,
    theme?: unknown,
    context?: unknown,
  ) => RenderedText;
  parameters: {
    required?: string[];
    properties?: {
      limit?: {
        maximum?: number;
      };
    };
    ir?: {
      props?: Array<{
        key?: string;
        opt?: boolean;
        val?: {
          max?: number;
        };
      }>;
    };
  };
}
