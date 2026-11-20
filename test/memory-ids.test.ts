import { describe, expect, it } from "vite-plus/test";
import {
  EARLIEST_MEMORY_MS,
  MEMORY_ID_CLOCK_SKEW_MS,
  isIngestedMessageId,
  ulidAt,
  ulidTime,
} from "../extensions/shared/memory-ids.ts";

const NOW = Date.UTC(2026, 8, 19, 18, 0, 0);

describe("ulid time", () => {
  it("decodes the instant a ULID was minted at", () => {
    expect(ulidTime(ulidAt(NOW))).toBe(NOW);
    expect(ulidTime("01M2XB6RGVDKFGNJP99YKP4PF8")).toBe(Date.parse("2026-09-19T17:25:13.371Z"));
  });
});

describe("ulid at", () => {
  it("spells the smallest id minted at an instant", () => {
    expect(ulidAt(Date.parse("2026-09-19T17:25:13.371Z"))).toBe("01M2XB6RGV0000000000000000");
    expect(ulidTime(ulidAt(NOW))).toBe(NOW);
    expect(ulidAt(0)).toBe("0".repeat(26));
  });
});

describe("ingested message ids", () => {
  it("recognizes the message ids the live service ranked", () => {
    for (const id of [
      "WPK4H0ERRS691YY0C2H523XNS8",
      "24N6TBDN9QEH7PXP4N4V42XC18",
      "CCRRV1QMJ8X4TH9H2CNDBN16Z0",
      "T2MJP4KQEK7Y23YAAF34PDMVBG",
    ]) {
      expect(isIngestedMessageId(id, NOW), id).toBe(true);
    }
  });

  it("keeps a memory id minted at any moment the service has existed", () => {
    expect(isIngestedMessageId("01M2XB6RGVDKFGNJP99YKP4PF8", NOW)).toBe(false);
    expect(isIngestedMessageId(ulidAt(EARLIEST_MEMORY_MS), NOW)).toBe(false);
    expect(isIngestedMessageId(ulidAt(NOW), NOW)).toBe(false);
    expect(isIngestedMessageId(ulidAt(NOW + MEMORY_ID_CLOCK_SKEW_MS), NOW)).toBe(false);
  });

  it("reads a time part outside the service's lifetime as a message", () => {
    expect(isIngestedMessageId(ulidAt(EARLIEST_MEMORY_MS - 1), NOW)).toBe(true);
    expect(isIngestedMessageId(ulidAt(NOW + MEMORY_ID_CLOCK_SKEW_MS + 1), NOW)).toBe(true);
    expect(isIngestedMessageId("00000000000000000000000000", NOW)).toBe(true);
  });

  it("leaves every other id shape to the memory path", () => {
    for (const id of [
      "mem-1",
      "",
      "01m2xb6rgvdkfgnjp99ykp4pf8",
      "01M2XB6RGVDKFGNJP99YKP4PF",
      "ILOU00000000000000000000A1",
    ]) {
      expect(isIngestedMessageId(id, NOW), JSON.stringify(id)).toBe(false);
    }
  });
});
