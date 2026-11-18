import type { ProfileParams } from "./memory-tools.types.ts";

/** Project namespaces the service doesn't have, and the notes the agent still owes a read. */
export interface MissingNamespaces {
  /** Look a namespace up ahead of time, so the answer is there when a run starts. */
  readonly check: (namespace: string) => void;
  /** Queue the agent's note when the scope's namespace is missing. Waits briefly to find out. */
  readonly watch: (scope: Readonly<ProfileParams>) => Promise<void>;
  /** Tell the agent about a scope an ingest already found missing. */
  readonly report: (scope: Readonly<ProfileParams>) => void;
  /** Hand over what the agent hasn't been told yet. */
  readonly notices: () => string[];
  /** Start over for a namespace somebody just created. */
  readonly forget: (namespace: string) => void;
}

/** A lookup that hangs past this is dropped. The first ingest finds out anyway. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** How long a run's start waits for the answer. A later answer makes the next run. */
const WATCH_WAIT_MS = 5000;

/**
 * The note for the agent, the one reader who can call the tool.
 *
 * @param scope - Scope that has no namespace.
 * @returns {string} The note.
 */
function agentNotice(scope: ProfileParams): string {
  const project = `${scope.namespace}/${scope.profile}`;
  return `agntn/memory: namespace ${scope.namespace} doesn't exist, so this session's conversation can't be ingested into ${project}. Create it with memory_namespace_create and the next ingest goes there.`;
}

/**
 * Whether the service answers 404 for a namespace. Any other failure means "can't tell".
 *
 * @param namespace - Namespace to look up.
 * @returns {Promise<boolean>} True for a 404 alone.
 */
async function lacksNamespace(namespace: string): Promise<boolean> {
  try {
    const { memoryToolExecutors } = await import("./memory-tools.ts");
    const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
    await memoryToolExecutors.getNamespace({ namespace }, { signal });
    return false;
  } catch (error) {
    return (error as { statusCode?: unknown } | null)?.statusCode === 404;
  }
}

/**
 * Track missing namespaces for one session and queue each one's note once.
 *
 * @returns {MissingNamespaces} The tracker the host feeds.
 */
export function createMissingNamespaces(): MissingNamespaces {
  /** One lookup per namespace, each resolving to whether the service lacks it. */
  const lookups = new Map<string, Promise<boolean>>();
  const told = new Set<string>();
  const pending: string[] = [];

  /**
   * The lookup for a namespace, started on the first ask.
   *
   * @param namespace - Namespace to look up.
   * @returns {Promise<boolean>} Whether the service lacks it.
   */
  function lookup(namespace: string): Promise<boolean> {
    const asked = lookups.get(namespace) ?? lacksNamespace(namespace);
    lookups.set(namespace, asked);
    return asked;
  }

  /**
   * Queue the note for a scope unless its namespace already got one.
   *
   * @param scope - Scope that has no namespace.
   */
  function report(scope: Readonly<ProfileParams>): void {
    if (told.has(scope.namespace)) return;
    told.add(scope.namespace);
    pending.push(agentNotice(scope));
  }

  return {
    check(namespace) {
      void lookup(namespace);
    },
    async watch(scope) {
      const asked = lookup(scope.namespace);
      const answered = asked.then((missing) => {
        if (missing && lookups.get(scope.namespace) === asked) report(scope);
      });
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WATCH_WAIT_MS);
      });
      await Promise.race([answered, waited]);
      clearTimeout(timer);
    },
    report,
    notices: () => pending.splice(0),
    forget(namespace) {
      lookups.delete(namespace);
      told.delete(namespace);
    },
  };
}
