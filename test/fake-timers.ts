import { vi } from "vite-plus/test";

/** Captured at import, before any test fakes the timers. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Settle a retrying call on fake timers, 250 fake ms for every 10 real ones.
 * Small steps let a first call finish loading modules without firing the MCP client's own timeout.
 * @param operation - Call started after `useRetryTimers`, before this helper runs.
 * @returns {Promise<unknown>} What the call resolved with, or what it rejected with.
 */
export async function settle(operation: Promise<unknown>): Promise<unknown> {
  let done = false;
  const outcome = operation.then(
    (value) => value,
    (failure: unknown) => failure,
  );
  void outcome.finally(() => {
    done = true;
  });
  while (!done) {
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((resolve) => {
      realSetTimeout(resolve, 10);
    });
  }
  return outcome;
}

/** Fake the timers a retry waits on. */
export function useRetryTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}
