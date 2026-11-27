import { describe, expect, it, vi } from "vitest";
import { readCompleteLifecycleSessionSnapshot as read } from "./sessionSnapshot.js";
describe("complete lifecycle session inventory", () => {
  it("includes archived, global, unknown and all pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ key: "a" }],
        totalCount: 2,
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        sessions: [{ key: "b" }],
        totalCount: 2,
        hasMore: false,
      });
    expect(await read(request)).toEqual({
      sessions: [{ key: "a" }, { key: "b" }],
      lifecycleSnapshotComplete: true,
    });
    expect(request).toHaveBeenNthCalledWith(1, {
      limit: 200,
      offset: 0,
      archived: "all",
      includeGlobal: true,
      includeUnknown: true,
    });
  });
  it.each([
    { sessions: [], totalCount: 1, hasMore: false },
    { sessions: [], totalCount: 1, hasMore: true, nextOffset: 0 },
    { sessions: [{ key: "a" }, { key: "a" }], totalCount: 2, hasMore: false },
    { sessions: [] },
  ])("rejects incomplete/ambiguous coverage %j", async (page) => {
    await expect(read(vi.fn().mockResolvedValue(page))).rejects.toThrow();
  });
  it("rejects changing inventory totals", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ key: "a" }],
        totalCount: 2,
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        sessions: [{ key: "b" }],
        totalCount: 3,
        hasMore: false,
      });
    await expect(read(request)).rejects.toThrow("changed");
  });
});
