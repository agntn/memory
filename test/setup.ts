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
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
];

for (const name of hostEnvironment) delete process.env[name];

// The Pi scope falls back to a file under the home directory, which delete
// cannot neutralize, so point the agent directory somewhere that cannot exist.
process.env.PI_CODING_AGENT_DIR = "/nonexistent/agntn-memory-tests";
