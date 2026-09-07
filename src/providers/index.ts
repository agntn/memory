import { register } from "../registry.ts";
import { cloudflareMemoryFactory } from "./cloudflare.ts";
import { mnemopiMemoryFactory } from "./mnemopi.ts";

export function registerAll(): void {
  register("cloudflare", cloudflareMemoryFactory);
  register("mnemopi", mnemopiMemoryFactory);
}

export {
  CloudflareMemoryProvider,
  CloudflareNamespaceClient,
  cloudflareMemoryFactory,
  cloudflareMemoryLimits,
} from "./cloudflare.ts";
export { MnemopiMemoryProfile, MnemopiMemoryProvider, mnemopiMemoryFactory } from "./mnemopi.ts";
export type { MnemopiClient, MnemopiMemoryOptions } from "./mnemopi.ts";
export type {
  AgentMemoryNamespaceBinding,
  AgentMemoryProfileBinding,
  CloudflareAccountOptions,
  CloudflareBindingOptions,
  CloudflareHttpOptions,
  CloudflareMemoryOptions,
  CloudflareMemoryProfile,
  CloudflareNamespace,
  CloudflareNamespaceListOptions,
  CloudflareNamespaceListResult,
  CloudflareProfile,
  CloudflareProfileListOptions,
  CloudflareProfileListResult,
} from "./cloudflare.ts";
