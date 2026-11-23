import { describe, expect, it } from "vite-plus/test";
import {
  configuredRedactionShapes,
  loadRedactor,
  parseRedactionShapes,
} from "../extensions/shared/redaction.ts";

const redact = await loadRedactor();

/* Published vectors: Bitcoin wiki WIF, BIP39 "abandon ... about", BIP32 test vector 1. */
const WIF = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ";
const COMPRESSED_WIF = "KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
const XPUB =
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const HEX = "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d";

describe("loadRedactor", () => {
  it.each([
    ["a WIF key", `key ${WIF} here`, "key [redacted:wif] here", "wif"],
    ["a compressed WIF key", `key ${COMPRESSED_WIF}`, "key [redacted:wif]", "wif"],
    ["a BIP39 phrase", `seed: ${MNEMONIC}, keep it`, "seed: [redacted:bip39], keep it", "bip39"],
    ["an xprv", `root ${XPRV}`, "root [redacted:extended-private-key]", "extended-private-key"],
    [
      "labelled hex",
      `private key: ${HEX}`,
      "private key: [redacted:hex-private-key]",
      "hex-private-key",
    ],
    [
      "a PEM block",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\nafter",
      "[redacted:private-key]\nafter",
      "private-key",
    ],
    [
      "a GitHub token",
      `gh auth ghp_${"a".repeat(36)}`,
      "gh auth [redacted:github-token]",
      "github-token",
    ],
    ["an sk- key", `OPENAI=sk-${"b".repeat(30)}`, "OPENAI=[redacted:api-key]", "api-key"],
    ["a Slack token", `xoxb-${"1".repeat(17)}`, "[redacted:slack-token]", "slack-token"],
    [
      "a Cloudflare token",
      `cfut_${"c".repeat(44)}`,
      "[redacted:cloudflare-token]",
      "cloudflare-token",
    ],
  ])("strikes %s", (_label, text, struck, shape) => {
    expect(redact(text)).toEqual({ text: struck, counts: { [shape]: 1 } });
  });

  it.each([
    ["a txid", `txid ${HEX}`],
    ["a WIF with a broken checksum", `${WIF.slice(0, -1)}j`],
    ["twelve list words without a checksum", "abandon ".repeat(12).trim()],
    ["an xpub", XPUB],
    ["addresses", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["plain prose", "We went to the park and then walked along the river until the sun went down"],
  ])("leaves %s alone", (_label, text) => {
    expect(redact(text)).toEqual({ text, counts: {} });
  });

  it("adds configured shapes after the built-in ones", async () => {
    const shapes = parseRedactionShapes(
      [{ name: "ticket", pattern: "acme-\\d+", ignoreCase: true }],
      "shapes",
    );
    const own = await loadRedactor(shapes);
    expect(own(`ACME-12 and ${WIF}`)).toEqual({
      text: "[redacted:ticket] and [redacted:wif]",
      counts: { wif: 1, ticket: 1 },
    });
  });

  it("strikes a seed that a checksummed phrase overlaps", () => {
    const seed = MNEMONIC.split(" ");
    const text = ["april", ...seed.slice(0, 10), ...seed].join(" ");
    expect(redact(text)).toEqual({ text: "[redacted:bip39]", counts: { bip39: 1 } });
  });

  it("gets through a message-sized whitespace run quickly", () => {
    const started = performance.now();
    redact(`x${" ".repeat(32_766)}x`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("configured shapes", () => {
  it("reads AGNTN_MEMORY_REDACT", () => {
    const shapes = configuredRedactionShapes({
      AGNTN_MEMORY_REDACT: '[{"name":"ticket","pattern":"T-\\\\d+"}]',
    });
    expect(shapes?.map(({ name }) => name)).toEqual(["ticket"]);
    expect(configuredRedactionShapes({})).toBeUndefined();
  });

  it.each([
    ["not JSON", "[", "AGNTN_MEMORY_REDACT must be a JSON array"],
    ["an object", "{}", "AGNTN_MEMORY_REDACT must be an array of shapes"],
    ["a bad name", '[{"name":"Bad Name","pattern":"x"}]', "needs a name"],
    ["a bad pattern", '[{"name":"bad","pattern":"("}]', "has an invalid pattern"],
    ["a built-in name", '[{"name":"wif","pattern":"x"}]', "names wif twice"],
  ])("refuses %s", (_label, value, message) => {
    expect(() => configuredRedactionShapes({ AGNTN_MEMORY_REDACT: value })).toThrow(message);
  });
});
