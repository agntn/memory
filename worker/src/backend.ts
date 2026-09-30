import type { MemoryBackend } from "../../packages/shared/memory-tools.types.ts";
import {
  type AgentMemoryNamespaceBinding,
  CloudflareMemoryProvider,
} from "../../src/providers/cloudflare.ts";

/**
 * Serve the memory tools from one Agent Memory binding.
 *
 * A binding reaches exactly the namespace it was configured with and has no
 * account-level namespace calls, so both limits are reported instead of
 * failing inside the provider.
 *
 * @param namespace - The namespace the binding is configured with.
 * @param binding - The `agent_memory` binding from the Worker env.
 * @returns {MemoryBackend} A backend for `createMemoryToolExecutors`.
 */
export function bindingMemoryBackend(
  namespace: string,
  binding: Readonly<AgentMemoryNamespaceBinding>,
): MemoryBackend {
  const provider = new CloudflareMemoryProvider({ binding });
  return {
    async provider(requested) {
      if (requested !== namespace) {
        throw new Error(`This server is bound to namespace ${namespace}`);
      }
      return provider;
    },
    async namespaces() {
      throw new Error("A Workers binding has no namespace management");
    },
  };
}
