import type { MemoryProvider } from "./memory.ts";
import { UnknownProviderError } from "./errors.ts";

export type MemoryProviderFactory<TOptions = unknown> = (options: TOptions) => MemoryProvider;

const registry = new Map<string, MemoryProviderFactory>();

export function register<TOptions>(name: string, factory: MemoryProviderFactory<TOptions>): void {
  registry.set(name, factory as MemoryProviderFactory);
}

export function create<TOptions>(name: string, options: TOptions): MemoryProvider {
  const factory = registry.get(name);
  if (!factory) throw new UnknownProviderError(`Unknown memory provider: ${name}`);
  return factory(options);
}

export function providers(): string[] {
  return [...registry.keys()];
}

export function has(name: string): boolean {
  return registry.has(name);
}
