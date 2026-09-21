/** Unicode categories that can change terminal layout without visible content. */
export const UNSAFE_TERMINAL_CHARACTER_PATTERN = "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]";

/** The same categories compiled once for text that crosses a tool result boundary. */
export const TOOL_TEXT_CONTROL_PATTERN = new RegExp(UNSAFE_TERMINAL_CHARACTER_PATTERN, "gu");

/**
 * Lossily replace layout controls in tool output; preserve the original value outside prose.
 * @param value - Untrusted text crossing the tool result boundary.
 * @returns {string} Display-only text with every layout control replaced by a space.
 */
export function singleLineToolText(value: string): string {
  return value.replaceAll(TOOL_TEXT_CONTROL_PATTERN, " ");
}
