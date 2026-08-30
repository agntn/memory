import { defineConfig } from "oxlint";
import oxlint from "@agntn/ox/oxlint";

const readonlyParameterOptions = {
  allow: [
    {
      from: "file" as const,
      name: [
        "AbortOptions",
        "AgentMemoryProfileBinding",
        "CloudflareAccountOptions",
        "CloudflareHttpClient",
        "CloudflareMemoryOptions",
        "CloudflareNamespaceListOptions",
        "GetParams",
        "IngestOptions",
        "IngestParams",
        "ListOptions",
        "ListParams",
        "Memory",
        "MemoryMessage",
        "MemoryParams",
        "MemoryProfile",
        "MemoryToolResult",
        "MnemopiClient",
        "MnemopiMemoryOptions",
        "NamespaceListParams",
        "NamespaceParams",
        "ProfileParams",
        "RecallCandidate",
        "RecallOptions",
        "RecallParams",
        "RecallResult",
        "RecallVisibilityParams",
        "RememberInput",
        "RememberParams",
        "RemovedCount",
        "RenderedToolResult",
        "RenderOptions",
        "SessionParams",
        "StatusLine",
        "StatusTheme",
        "SummaryOptions",
        "SummaryParams",
        "SupersedeParams",
      ],
    },
    {
      from: "lib" as const,
      name: ["AbortSignal", "Date", "Iterable", "ReadonlyMap", "RequestInit", "Response"],
    },
    {
      from: "package" as const,
      name: [
        "AbortOptions",
        "CloudflareAccountOptions",
        "CloudflareMemoryOptions",
        "IngestOptions",
        "ListOptions",
        "Memory",
        "MemoryMessage",
        "MemoryProfile",
        "RecallCandidate",
        "RecallOptions",
        "RecallResult",
        "RememberInput",
        "SummaryOptions",
      ],
      package: "@agntn/memory",
    },
    {
      from: "package" as const,
      name: ["RequestInit", "Response"],
      package: "undici-types",
    },
    {
      from: "package" as const,
      name: ["ExtensionAPI", "ExtensionContext", "ToolDefinition"],
      package: "@earendil-works/pi-coding-agent",
    },
    {
      from: "package" as const,
      name: ["ExtensionAPI", "ExtensionContext", "ToolDefinition"],
      package: "@oh-my-pi/pi-coding-agent",
    },
  ],
  ignoreInferredTypes: true,
};

export default defineConfig({
  ...oxlint,
  rules: {
    ...oxlint.rules,
    "typescript/prefer-readonly-parameter-types": ["error", readonlyParameterOptions],
  },
  overrides: [
    {
      /** Test fixtures use mutable host shapes and Vitest's intentionally `any` asymmetric matchers. */
      files: ["test/**/*.{ts,mjs}"],
      rules: {
        "jsdoc/require-param": "off",
        "jsdoc/require-param-description": "off",
        "jsdoc/require-param-name": "off",
        "jsdoc/require-returns": "off",
        "jsdoc/require-returns-description": "off",
        "jsdoc/require-returns-type": "off",
        "jsdoc/require-throws-type": "off",
        "jsdoc/require-yields-type": "off",
        "typescript/no-base-to-string": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/prefer-readonly-parameter-types": "off",
        "typescript/unbound-method": "off",
      },
    },
    {
      /** The packed smoke test loads an unpacked tarball dynamically, so JavaScript has no static package types. */
      files: ["test/eval-packed.mjs"],
      rules: {
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-function-type": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
      },
    },
  ],
  ignorePatterns: ["dist", "coverage"],
});
