import { MemoryInputError, MemoryMigrationError } from "./errors.ts";
import type { MemoryProfile } from "./memory.ts";
import type { AbortOptions, Memory, MemoryListEntry, MigratedMemory } from "./types.ts";

/** Records per listing page while walking a whole profile. */
const PAGE_SIZE = 100;
/** Reads in flight at once, so a big profile doesn't open thousands of requests. */
const READ_CONCURRENCY = 8;
/** The kinds a relates: line takes, as the tools write them; a test keeps the two lists equal. */
export const MIGRATED_RELATION_KINDS: ReadonlySet<string> = new Set([
  "confirms",
  "complements",
  "narrows",
  "corrects",
  "refutes",
  "depends-on",
]);
/** One relates: line, its kind and id first, the way the tools write it. */
const relationLinePattern = /^relates: ([a-z-]+) (\S+)((?: "(?:[^"\\]|\\.)*")?)$/gmu;

/** The two profiles a migration runs between. */
export interface MemoryMigrationRoute {
  readonly from: MemoryProfile;
  readonly to: MemoryProfile;
}

export interface MemoryMigrationOptions extends AbortOptions {
  /** List the source and stop: `memories` comes back empty and nothing is written. */
  readonly dryRun?: boolean;
  /** Leave the source records in place, so the migration copies instead of moving. */
  readonly keepSource?: boolean;
  /** Text each new record ends with, given the old id. Left out, content moves verbatim. */
  readonly stamp?: (memoryId: string) => string;
  /** Refuse before the first write when a new record would pass this many UTF-8 bytes. */
  readonly maxContentBytes?: number;
}

export interface MemoryMigrationResult {
  /** Records the source listing showed, which leaves superseded ones out. */
  readonly listed: number;
  /** Old id to new id for every listed record, oldest first. Empty after a dry run. */
  readonly memories: readonly MigratedMemory[];
  /** Source records deleted, zero under `keepSource` or `dryRun`. */
  readonly deleted: number;
}

/** One record on its way: what it was, what it becomes, and where it landed. */
interface Move {
  readonly source: Memory;
  readonly content: string;
  readonly to: string;
  readonly skipped: boolean;
}

/** Which profile a step touches, and its abort signal. */
interface MigrationStep extends AbortOptions {
  readonly side: "source" | "target";
}

/** A read of chosen ids. */
interface MigrationRead extends MigrationStep {
  readonly ids: readonly string[];
}

/** Where a migration stopped and what it got done before. */
interface MigrationStop {
  readonly memoryId?: string;
  readonly memories: readonly MigratedMemory[];
  readonly deleted: number;
}

/**
 * One profile operation, or a refusal naming the side that lacks it.
 *
 * @param profile - Source or target profile.
 * @param name - The operation the migration needs.
 * @param side - Which profile it is, for the message.
 * @returns {NonNullable<MemoryProfile[K]>} The bound operation.
 * @throws {TypeError} When the provider has no such call.
 */
function operation<K extends keyof MemoryProfile>(
  profile: MemoryProfile,
  name: K,
  side: MigrationStep["side"],
): NonNullable<MemoryProfile[K]> {
  const call = profile[name];
  if (typeof call !== "function") {
    throw new TypeError(`The ${side} profile's provider does not support ${name}`);
  }
  return call.bind(profile) as NonNullable<MemoryProfile[K]>;
}

/**
 * Every listed record of a profile, page after page, oldest first.
 *
 * @param profile - Profile to walk.
 * @param step - Side and abort signal.
 * @returns {Promise<MemoryListEntry[]>} The listing in service order.
 */
async function listAll(profile: MemoryProfile, step: MigrationStep): Promise<MemoryListEntry[]> {
  const list = operation(profile, "list", step.side);
  const entries: MemoryListEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({
      limit: PAGE_SIZE,
      signal: step.signal,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.memories);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return entries;
}

/**
 * Read records by id a few at a time, in order. One failed read fails them all.
 *
 * @param profile - Profile to read.
 * @param step - Ids to read, side and abort signal.
 * @returns {Promise<Memory[]>} The records, in the order of `ids`.
 */
async function readAll(profile: MemoryProfile, step: MigrationRead): Promise<Memory[]> {
  const get = operation(profile, "get", step.side);
  const memories: Memory[] = [];
  for (let start = 0; start < step.ids.length; start += READ_CONCURRENCY) {
    const batch = step.ids.slice(start, start + READ_CONCURRENCY);
    memories.push(...(await Promise.all(batch.map((id) => get(id, { signal: step.signal })))));
  }
  return memories;
}

/**
 * Point each relates: line at the new id of a memory that moved with it. Other lines stay.
 *
 * @param content - Stored memory content.
 * @param ids - Old id to new id.
 * @returns {string} The content with the moved ids swapped in.
 */
export function withRelationIds(content: string, ids: ReadonlyMap<string, string>): string {
  return content.replaceAll(
    relationLinePattern,
    (line: string, rel: string, id: string, point: string) => {
      const moved = ids.get(id);
      return moved === undefined || !MIGRATED_RELATION_KINDS.has(rel)
        ? line
        : `relates: ${rel} ${moved}${point}`;
    },
  );
}

/**
 * The content with every relates: id blanked, for a record whose related memory moved in an earlier run.
 *
 * @param content - Stored memory content.
 * @returns {string} The content with `*` in place of each relation id.
 */
function withoutRelationIds(content: string): string {
  return content.replaceAll(
    relationLinePattern,
    (line: string, rel: string, _id: string, point: string) =>
      MIGRATED_RELATION_KINDS.has(rel) ? `relates: ${rel} *${point}` : line,
  );
}

/**
 * The key a moved record is found by: its session and its content.
 *
 * @param record - Session and content of a record.
 * @returns {string} One string per pair.
 */
function moveKey(record: Readonly<Pick<Memory, "sessionId" | "content">>): string {
  return JSON.stringify([record.sessionId, record.content]);
}

/**
 * What the target already holds, found by exact content first and by content with its relation ids blanked second.
 *
 * A record whose related memory a failed run already moved and deleted can't
 * spell the new id any more, so the second key still finds it.
 */
class TargetRecords {
  readonly #exact = new Map<string, Memory[]>();
  readonly #loose = new Map<string, Memory[]>();
  readonly #taken = new Set<string>();

  /**
   * Index records read from the target.
   *
   * @param records - Target records, oldest first.
   */
  constructor(records: readonly Memory[]) {
    for (const record of records) {
      const exact = moveKey(record);
      const loose = moveKey({ ...record, content: withoutRelationIds(record.content) });
      this.#exact.set(exact, [...(this.#exact.get(exact) ?? []), record]);
      this.#loose.set(loose, [...(this.#loose.get(loose) ?? []), record]);
    }
  }

  /**
   * Take the oldest untaken record holding this session and content.
   *
   * @param record - Session and the content a moved record would get.
   * @returns {Memory | undefined} The record, which no later lookup returns again.
   */
  take(record: Readonly<Pick<Memory, "sessionId" | "content">>): Memory | undefined {
    const loose = { ...record, content: withoutRelationIds(record.content) };
    const found = [
      ...(this.#exact.get(moveKey(record)) ?? []),
      ...(this.#loose.get(moveKey(loose)) ?? []),
    ].find(({ id }) => !this.#taken.has(id));
    if (found !== undefined) this.#taken.add(found.id);
    return found;
  }
}

/**
 * The target's listed records in the sessions the source uses, read in full.
 *
 * A record from another session can't be one this migration wrote, so only
 * the matching sessions cost a read each.
 *
 * @param to - Target profile.
 * @param state - The target listing, the source records and abort signal.
 * @returns {Promise<TargetRecords>} The records, ready to be found.
 */
async function targetRecords(
  to: MemoryProfile,
  state: AbortOptions &
    Readonly<{ listed: readonly MemoryListEntry[]; sources: readonly Memory[] }>,
): Promise<TargetRecords> {
  const sessions = new Set(state.sources.map(({ sessionId }) => sessionId));
  const ids = state.listed.filter(({ sessionId }) => sessions.has(sessionId)).map(({ id }) => id);
  return new TargetRecords(await readAll(to, { side: "target", ids, signal: state.signal }));
}

/**
 * Refuse one profile as both ends, which two wrappers over it would hide from `===`.
 *
 * @param sources - The source listing.
 * @param targets - The target listing.
 * @throws {MemoryInputError} When a record shows in both.
 */
function assertTwoProfiles(
  sources: readonly MemoryListEntry[],
  targets: readonly MemoryListEntry[],
): void {
  const ids = new Set(sources.map(({ id }) => id));
  if (targets.some(({ id }) => ids.has(id))) {
    throw new MemoryInputError("Source and target are the same profile, so nothing was written");
  }
}

/**
 * Whether the service moved a record's updatedAt, which only supersession does.
 *
 * @param memory - A record read by id.
 * @returns {boolean} `true` for a superseded record.
 */
function isSuperseded(memory: Memory): boolean {
  return memory.updatedAt.getTime() > memory.createdAt.getTime();
}

/**
 * The id map as far as a migration got.
 *
 * @param moves - Records written or found so far.
 * @param read - Records read back by new id, once the check got that far.
 * @returns {MigratedMemory[]} One entry per move.
 */
function migrated(moves: readonly Move[], read?: ReadonlyMap<string, Memory>): MigratedMemory[] {
  return moves.map(({ source, to, skipped }) => {
    const record = read?.get(to);
    return {
      from: source.id,
      to,
      skipped,
      superseded: record !== undefined && isSuperseded(record),
    };
  });
}

/**
 * Wrap a failure with the id map, so the caller knows what landed before it.
 *
 * @param error - What failed.
 * @param state - Failing record, map so far and deletions so far.
 * @returns {MemoryMigrationError} The failure with its map.
 */
function stopped(error: unknown, state: MigrationStop): MemoryMigrationError {
  const reason = error instanceof Error ? error.message : String(error);
  const at = state.memoryId === undefined ? "" : ` at memory ${JSON.stringify(state.memoryId)}`;
  return new MemoryMigrationError(`Migration stopped${at}: ${reason}`, { ...state, cause: error });
}

/**
 * Refuse the whole migration before any write when one record would grow past the cap.
 *
 * @param sources - Source records.
 * @param options - The cap and the stamp, if any.
 * @throws {MemoryInputError} Naming the first record that doesn't fit.
 */
function assertContentBytes(
  sources: readonly Memory[],
  options: Readonly<Pick<MemoryMigrationOptions, "maxContentBytes" | "stamp">>,
): void {
  const { maxContentBytes: cap, stamp } = options;
  if (cap === undefined) return;
  const encoder = new TextEncoder();
  for (const source of sources) {
    const bytes = encoder.encode(`${source.content}${stamp?.(source.id) ?? ""}`).length;
    if (bytes > cap) {
      throw new MemoryInputError(
        `Memory ${JSON.stringify(source.id)} would take ${bytes} of ${cap} UTF-8 bytes in the target, so nothing was written`,
      );
    }
  }
}

/**
 * Write each record to the target in order, taking a record that already holds it.
 *
 * A relates: line names an older memory, and the listing runs oldest first, so
 * every line inside the moved set points at a record mapped before it.
 *
 * @param sources - Source records, oldest first.
 * @param state - Target profile, its records, the stamp and abort signal.
 * @returns {Promise<Move[]>} One move per record.
 * @throws {MemoryMigrationError} When a write fails, with every move before it.
 */
async function writeAll(
  sources: readonly Memory[],
  state: AbortOptions &
    Readonly<{
      to: MemoryProfile;
      present: TargetRecords;
      stamp?: (memoryId: string) => string;
    }>,
): Promise<Move[]> {
  const remember = operation(state.to, "remember", "target");
  const ids = new Map<string, string>();
  const moves: Move[] = [];
  for (const source of sources) {
    const written = `${withRelationIds(source.content, ids)}${state.stamp?.(source.id) ?? ""}`;
    const found = state.present.take({ sessionId: source.sessionId, content: written });
    try {
      const record =
        found ??
        (await remember(
          { content: written, sessionId: source.sessionId },
          { signal: state.signal },
        ));
      ids.set(source.id, record.id);
      const content = found?.content ?? written;
      moves.push({ source, content, to: record.id, skipped: found !== undefined });
    } catch (error) {
      throw stopped(error, { memoryId: source.id, memories: migrated(moves), deleted: 0 });
    }
  }
  return moves;
}

/**
 * Read every target record back and compare it with what it should hold.
 *
 * @param moves - Records written or found.
 * @param state - Target profile and abort signal.
 * @returns {Promise<Map<string, Memory>>} The target records by new id.
 * @throws {MemoryMigrationError} When a read fails or a record differs.
 */
async function verifyAll(
  moves: readonly Move[],
  state: AbortOptions & Readonly<{ to: MemoryProfile }>,
): Promise<Map<string, Memory>> {
  const ids = moves.map(({ to }) => to);
  let records: Memory[];
  try {
    records = await readAll(state.to, { side: "target", ids, signal: state.signal });
  } catch (error) {
    throw stopped(error, { memories: migrated(moves), deleted: 0 });
  }
  const read = new Map(records.map((record) => [record.id, record]));
  const changed = moves.find(({ source, content, to }) => {
    const record = read.get(to);
    return record === undefined || moveKey(record) !== moveKey({ ...source, content });
  });
  if (changed !== undefined) {
    const error = new Error(
      `target memory ${JSON.stringify(changed.to)} reads back with other content or session`,
    );
    const memories = migrated(moves, read);
    throw stopped(error, { memoryId: changed.source.id, memories, deleted: 0 });
  }
  return read;
}

/**
 * Delete the source records once every new record checks out.
 *
 * A record superseded in the target is gone from its listing, so a repeated
 * migration would write it again, newer than the record that replaced it:
 * those sources go first. The rest go newest first, and since a relates: line
 * names an older record, what a failed delete leaves is the oldest part of the
 * set with every record its lines name, which a repeated migration finds.
 *
 * @param from - Source profile.
 * @param state - The verified map and abort signal.
 * @returns {Promise<number>} How many were deleted.
 * @throws {MemoryMigrationError} When a delete fails, with how many went before it.
 */
async function deleteAll(
  from: MemoryProfile,
  state: AbortOptions & Readonly<{ memories: readonly MigratedMemory[] }>,
): Promise<number> {
  const remove = operation(from, "delete", "source");
  let deleted = 0;
  const newestFirst = state.memories.toReversed();
  const order = [
    ...newestFirst.filter(({ superseded }) => superseded),
    ...newestFirst.filter(({ superseded }) => !superseded),
  ];
  for (const { from: id } of order) {
    try {
      await remove(id, { signal: state.signal });
    } catch (error) {
      throw stopped(error, { memoryId: id, memories: state.memories, deleted });
    }
    deleted += 1;
  }
  return deleted;
}

/**
 * Move every listed memory of one profile into another, which may sit in another namespace.
 *
 * The service can't move a record, so each one is read, written to the target
 * with its session and read back, and the source goes only after all of them
 * check out. A target record already holding the session and content a record
 * would get counts as moved, which makes a failed migration safe to run again. New records get new ids and timestamps, and the service assigns their
 * types and summaries again. Superseded versions and ingested messages stay.
 *
 * @param route - Source and target profile.
 * @param options - Dry run, copy mode, stamp, byte cap and abort signal.
 * @returns {Promise<MemoryMigrationResult>} The listed count, the id map and the deletions.
 * @throws {MemoryInputError} When both are one profile, or a record would not fit.
 * @throws {MemoryMigrationError} When a step fails, with the id map so far.
 */
export async function migrateMemories(
  route: MemoryMigrationRoute,
  options: MemoryMigrationOptions = {},
): Promise<MemoryMigrationResult> {
  const { from, to } = route;
  if (from === to) throw new MemoryInputError("A migration needs two different profiles");
  const { signal, stamp } = options;
  const entries = await listAll(from, { side: "source", signal });
  if (options.dryRun === true) return { listed: entries.length, memories: [], deleted: 0 };
  const listed = await listAll(to, { side: "target", signal });
  assertTwoProfiles(entries, listed);
  const ids = entries.map(({ id }) => id);
  const sources = await readAll(from, { side: "source", ids, signal });
  assertContentBytes(sources, options);
  const present = await targetRecords(to, { listed, sources, signal });
  const moves = await writeAll(sources, { to, present, stamp, signal });
  const memories = migrated(moves, await verifyAll(moves, { to, signal }));
  const deleted = options.keepSource === true ? 0 : await deleteAll(from, { memories, signal });
  return { listed: entries.length, memories, deleted };
}
