import type { execFile } from "node:child_process";
import { vi } from "vitest";

/**
 * Neutralize the host configuration this library reads from the environment.
 *
 * The README tells a production host to export the operational scope and the
 * Cloudflare credentials, so a contributor's shell may already carry them. The
 * suite asserts both the raw and the bound tool surfaces, and an ambient scope
 * would flip every unstubbed construction into bound mode. Without ambient
 * credentials, a test that forgets to stub fetch fails on the credential check
 * instead of sending a live request under a real account token.
 */
const hostEnvironment = [
  "AGNTN_MEMORY_NAMESPACE",
  "AGNTN_MEMORY_PROFILE",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "AGNTN_CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
];

for (const name of hostEnvironment) delete process.env[name];

// The Pi scope falls back to a file under the home directory, which delete
// cannot neutralize, so point the agent directory somewhere that cannot exist.
process.env.PI_CODING_AGENT_DIR = "/nonexistent/agntn-memory-tests";

// Without an env token the memory tools ask the cf CLI for its OAuth session,
// and a contributor logged in to cf would otherwise lend the suite a live
// account token. A test that exercises that path supplies its own cf.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const notFound = Object.assign(new Error("spawn cf ENOENT"), { code: "ENOENT" });
  return {
    ...actual,
    execFile: vi.fn(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(notFound, "", ""));
    }) as unknown as typeof execFile),
  };
});
