import { describe, expect, it } from "vitest";
import { decodeRef, encodeRef, type RefKind } from "../../../src/storage/refs.ts";

const KINDS: RefKind[] = ["conversation", "message", "summaryUnit", "summaryFinding"];

describe("short reference codec", () => {
  it("round-trips every kind", () => {
    for (const kind of KINDS) {
      for (const id of [1, 35, 36, 46655, 9_007_199_254_740_991]) {
        const ref = encodeRef(kind, id);
        expect(decodeRef(ref)).toEqual({ kind, id });
      }
    }
  });

  it("uses the documented prefixes", () => {
    expect(encodeRef("conversation", 12)).toBe("qqc_c");
    expect(encodeRef("message", 10706)).toBe("qqm_89e");
    expect(encodeRef("summaryUnit", 42)).toBe("qqsu_16");
    expect(encodeRef("summaryFinding", 127)).toBe("qqsf_3j");
  });

  it("rejects malformed references", () => {
    expect(decodeRef("qqx_12")).toBeUndefined();
    expect(decodeRef("qqm_")).toBeUndefined();
    expect(decodeRef("qqm_ABC")).toBeUndefined();
    expect(decodeRef("qqm_1-2")).toBeUndefined();
    expect(decodeRef("qqm_0")).toBeUndefined();
    expect(decodeRef("noprefix")).toBeUndefined();
    expect(decodeRef("")).toBeUndefined();
    expect(decodeRef("qqm_zzzzzzzzzzzzzzzz")).toBeUndefined();
  });

  it("refuses to encode invalid ids", () => {
    expect(() => encodeRef("message", 0)).toThrow();
    expect(() => encodeRef("message", -5)).toThrow();
    expect(() => encodeRef("message", 1.5)).toThrow();
  });
});
