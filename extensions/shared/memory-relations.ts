import {
  MAX_TOOL_MEMORY_CONTENT_CHARACTERS,
  MAX_TOOL_MEMORY_RELATIONS,
  MAX_TOOL_RELATION_POINT_CHARACTERS,
  MEMORY_ID_PATTERN,
  MEMORY_RELATION_KINDS,
} from "./memory-tool-contract.ts";
import { UNSAFE_TERMINAL_CHARACTER_PATTERN } from "./terminal-text.ts";

/** How a newer memory bears on an older one. */
export type MemoryRelationKind = (typeof MEMORY_RELATION_KINDS)[number];

/** One older memory a write names, and the point it's about. */
export interface MemoryRelation {
  readonly id: string;
  readonly rel: MemoryRelationKind;
  readonly point?: string;
}

const kinds: ReadonlySet<string> = new Set(MEMORY_RELATION_KINDS);
const idPattern = new RegExp(MEMORY_ID_PATTERN, "u");
/** Controls, bidi marks and line breaks, so a point can't forge or flip a line. */
const unsafePattern = new RegExp(UNSAFE_TERMINAL_CHARACTER_PATTERN, "u");
/** A blank line, then only `key: value` lines up to the end, as host fields leave content. */
const fieldBlockPattern = /\n\n[a-z][a-z0-9_]{0,63}: [^\n]+(?:\n[a-z][a-z0-9_]{0,63}: [^\n]+)*$/u;
const relationLinePattern = /^relates: ([a-z-]+) (\S+)(?: ("(?:[^"\\]|\\.)*"))?$/gmu;

/**
 * Check one relation, so its line always reads back as the same kind, id and point.
 *
 * @param value - One entry of `relates`.
 * @returns {MemoryRelation} The entry with its point trimmed.
 * @throws {Error} On an unknown kind, an id with spaces or a point that isn't one short line.
 */
function parseRelation(value: Readonly<MemoryRelation>): MemoryRelation {
  if (typeof value.id !== "string" || !idPattern.test(value.id) || /\s/u.test(value.id)) {
    throw new Error("Each relation needs the exact id of an older memory");
  }
  if (!kinds.has(value.rel)) {
    throw new Error(`Relation kind must be one of ${MEMORY_RELATION_KINDS.join(", ")}`);
  }
  if (value.point === undefined) return { id: value.id, rel: value.rel };
  return { id: value.id, rel: value.rel, point: parsePoint(value.point) };
}

/**
 * Check the point a relation is about.
 *
 * @param value - The `point` of one relation.
 * @returns {string} The point without surrounding whitespace.
 * @throws {Error} When it isn't one short nonblank line.
 */
function parsePoint(value: unknown): string {
  const point = typeof value === "string" ? value.trim() : "";
  if (point === "" || unsafePattern.test(point)) {
    throw new Error("A relation point must be one nonblank line");
  }
  if (point.length > MAX_TOOL_RELATION_POINT_CHARACTERS) {
    throw new Error(
      `A relation point takes up to ${MAX_TOOL_RELATION_POINT_CHARACTERS} characters`,
    );
  }
  return point;
}

/**
 * Check every relation before the first read, since the schema guards only tool callers.
 *
 * @param relates - The `relates` argument.
 * @returns {MemoryRelation[]} The checked relations, in call order.
 * @throws {Error} On a bad count, a bad entry or the same entry twice.
 */
export function parseRelations(relates: readonly Readonly<MemoryRelation>[]): MemoryRelation[] {
  const count = Array.isArray(relates as unknown) ? relates.length : 0;
  if (count < 1 || count > MAX_TOOL_MEMORY_RELATIONS) {
    throw new Error(`Relates must be a list of 1 to ${MAX_TOOL_MEMORY_RELATIONS} relations`);
  }
  const relations = relates.map((relation) => parseRelation(relation));
  const lines = relations.map((relation) => relationLine(relation));
  if (new Set(lines).size !== lines.length) {
    throw new Error("Relates names the same relation twice");
  }
  return relations;
}

/**
 * The line one relation adds to content.
 *
 * @param relation - A checked relation.
 * @returns {string} `relates: <kind> <id>`, then the quoted point when there is one.
 */
function relationLine(relation: Readonly<MemoryRelation>): string {
  const point = relation.point === undefined ? "" : ` ${JSON.stringify(relation.point)}`;
  return `relates: ${relation.rel} ${relation.id}${point}`;
}

/**
 * Append one `relates:` line per relation, unless a retry already carries them.
 *
 * @param content - Content after the host stamped its fields.
 * @param relations - Checked relations.
 * @returns {string} The content the service gets.
 * @throws {Error} When the lines would push the content past the service's byte cap.
 */
export function withRelationLines(
  content: string,
  relations: readonly Readonly<MemoryRelation>[],
): string {
  const own = relations.map((relation) => relationLine(relation));
  const present = new Set(content.split("\n"));
  if (own.every((line) => present.has(line))) return content;
  const lines = own.join("\n");
  const endsWithFields = fieldBlockPattern.test(content);
  const block = endsWithFields ? `\n${lines}` : `\n\n${lines}`;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content + block).length;
  if (bytes > MAX_TOOL_MEMORY_CONTENT_CHARACTERS) {
    throw new Error(
      `Relations add ${encoder.encode(block).length} bytes, taking the content to ${bytes} of ${MAX_TOOL_MEMORY_CONTENT_CHARACTERS} UTF-8 bytes; shorten the content or the points`,
    );
  }
  return content + block;
}

/**
 * Read the `relates:` lines stored content carries, skipping any that don't parse or aren't safe.
 *
 * @param content - Stored memory content.
 * @returns {MemoryRelation[]} Every relation that parses, in content order.
 */
export function relationsIn(content: string): MemoryRelation[] {
  return [...content.matchAll(relationLinePattern)].flatMap(([, rel, id, quoted]) => {
    if (rel === undefined || id === undefined || !kinds.has(rel)) return [];
    const relation = { id, rel: rel as MemoryRelationKind };
    if (quoted === undefined) return [relation];
    try {
      const point = JSON.parse(quoted) as string;
      return unsafePattern.test(point) ? [] : [{ ...relation, point }];
    } catch {
      return [];
    }
  });
}
