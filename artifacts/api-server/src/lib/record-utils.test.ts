import { describe, expect, it } from "vitest";
import {
  asArray,
  entityOf,
  mapLimit,
  num,
  recordOf,
  str,
} from "./record-utils.js";

describe("recordOf / entityOf / asArray", () => {
  it("coerces non-objects to an empty record", () => {
    expect(recordOf(null)).toEqual({});
    expect(recordOf(undefined)).toEqual({});
    expect(recordOf("candidate")).toEqual({});
    expect(recordOf(5)).toEqual({});
    expect(recordOf({ id: 7 })).toEqual({ id: 7 });
  });

  it("unwraps a single entity envelope and leaves list envelopes intact", () => {
    expect(entityOf({ id: 1, name: "Ada" })).toEqual({ id: 1, name: "Ada" });
    expect(entityOf({ data: { id: 2 } })).toEqual({ id: 2 });

    const listEnvelope = { data: [{ id: 3 }], total: 1 };
    expect(entityOf(listEnvelope)).toBe(listEnvelope);
    expect(entityOf({ data: null })).toEqual({ data: null });
    expect(entityOf(null)).toEqual({});
  });

  it("reads either a raw array or a Bullhorn data envelope", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ data: ["a"] })).toEqual(["a"]);
    expect(asArray({ data: { id: 1 } })).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray("skills")).toEqual([]);
  });
});

describe("str / num", () => {
  it("stringifies primitives and refuses objects so associations do not become [object Object]", () => {
    expect(str("Austin")).toBe("Austin");
    expect(str(0)).toBe("0");
    expect(str(false)).toBe("false");
    expect(str(null)).toBe("");
    expect(str(undefined)).toBe("");
    expect(str({ name: "Java" })).toBe("");
    expect(str(["Java", "SQL"])).toBe("");
  });

  it("coerces finite numbers and numeric strings, and rejects everything else", () => {
    expect(num(0)).toBe(0);
    expect(num(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(num("42")).toBe(42);
    expect(num(" 3.5 ")).toBe(3.5);
    expect(num("")).toBeNull();
    expect(num("   ")).toBeNull();
    expect(num("nope")).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(true)).toBeNull();
    expect(num({})).toBeNull();
  });
});

describe("mapLimit", () => {
  it("returns an empty list without calling the worker", async () => {
    let calls = 0;
    const result = await mapLimit([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("keeps input order when later items settle first", async () => {
    const release: Array<() => void> = [];
    const pending = mapLimit(["a", "b", "c"], 3, (item) => {
      return new Promise<string>((resolve) => {
        release.push(() => resolve(item.toUpperCase()));
      });
    });
    expect(release).toHaveLength(3);
    release[2]!();
    release[0]!();
    release[1]!();
    await expect(pending).resolves.toEqual(["A", "B", "C"]);
  });

  it("never starts more work than the limit, then drains the rest in order", async () => {
    let started = 0;
    const release: Array<() => void> = [];
    const pending = mapLimit([10, 20, 30, 40], 2, (item) => {
      started += 1;
      return new Promise<number>((resolve) => {
        release.push(() => resolve(item));
      });
    });

    expect(started).toBe(2);
    expect(release).toHaveLength(2);

    release[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(3);

    release[1]!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toBe(4);

    release[2]!();
    release[3]!();
    await expect(pending).resolves.toEqual([10, 20, 30, 40]);
  });

  it("still finishes when the limit is 0 by running one at a time", async () => {
    const result = await mapLimit(["x", "y"], 0, async (item) => item);
    expect(result).toEqual(["x", "y"]);
  });

  it("rejects when a worker throws instead of dropping the failure", async () => {
    await expect(
      mapLimit([1], 2, async () => {
        throw new Error("bullhorn timeout");
      }),
    ).rejects.toThrow("bullhorn timeout");
  });
});
