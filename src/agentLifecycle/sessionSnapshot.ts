import { z } from "zod";

const pageSchema = z.object({
  sessions: z.array(z.record(z.string(), z.unknown())),
  totalCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
});

/** Never infer run disappearance from a bounded/default or filtered first page. */
export async function readCompleteLifecycleSessionSnapshot(
  request: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const sessions: Record<string, unknown>[] = [];
  const keys = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = pageSchema.parse(
      await request({
        limit: 200,
        offset,
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
      }),
    );
    if (total !== undefined && total !== page.totalCount)
      throw new Error("Lifecycle session inventory changed during pagination");
    total = page.totalCount;
    for (const session of page.sessions) {
      if (typeof session.key !== "string" || keys.has(session.key))
        throw new Error("Ambiguous lifecycle session inventory");
      keys.add(session.key);
      sessions.push(session);
    }
    if (!page.hasMore) {
      if (sessions.length !== total)
        throw new Error("Incomplete lifecycle session inventory");
      return { sessions, lifecycleSnapshotComplete: true };
    }
    if (
      page.nextOffset === undefined ||
      page.nextOffset === null ||
      page.nextOffset <= offset
    )
      throw new Error("Invalid lifecycle session pagination");
    offset = page.nextOffset;
  }
  throw new Error("Lifecycle session pagination limit exceeded");
}
