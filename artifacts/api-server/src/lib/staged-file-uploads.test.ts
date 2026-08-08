import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  firmId: string;
  userId: string;
  uploadToken: string;
  batchId: string | null;
  fileName: string | null;
  contentType: string | null;
  content: Buffer | null;
  sizeBytes: number | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

const rows = new Map<string, Row>();

vi.mock("@workspace/db", () => {
  const stagedFileUploadsTable = {
    id: "id",
    firmId: "firmId",
    userId: "userId",
    uploadToken: "uploadToken",
    batchId: "batchId",
    fileName: "fileName",
    contentType: "contentType",
    content: "content",
    sizeBytes: "sizeBytes",
    expiresAt: "expiresAt",
    consumedAt: "consumedAt",
    createdAt: "createdAt",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    insert: () => ({
      values: async (v: Row) => {
        rows.set(v.id, { ...v, createdAt: v.createdAt ?? new Date() });
      },
    }),
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: (pred: { __filter?: (r: Row) => boolean }) => {
          const run = async (n?: number) => {
            const all = [...rows.values()].filter((r) =>
              pred.__filter ? pred.__filter(r) : true,
            );
            const picked = typeof n === "number" ? all.slice(0, n) : all;
            if (!cols) return picked;
            return picked.map((r) => {
              const out: Record<string, unknown> = {};
              for (const key of Object.keys(cols)) {
                out[key] = (r as Record<string, unknown>)[key];
              }
              return out;
            });
          };
          return {
            limit: (n: number) => run(n),
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              run().then(resolve, reject),
          };
        },
      }),
    }),
    update: () => {
      let patch: Partial<Row> = {};
      return {
        set: (p: Partial<Row>) => {
          patch = p;
          const whereFn = (pred: { __filter?: (r: Row) => boolean }) => {
            const apply = () => {
              const updated: Row[] = [];
              for (const [id, row] of rows) {
                if (pred.__filter && !pred.__filter(row)) continue;
                const next = { ...row, ...patch };
                rows.set(id, next);
                updated.push(next);
              }
              return updated;
            };
            const promise = Promise.resolve(apply()).then(() => ({ rowCount: 1 }));
            return Object.assign(promise, {
              returning: async (cols: Record<string, unknown>) => {
                const updated = apply();
                return updated.map((r) => {
                  const out: Record<string, unknown> = {};
                  for (const key of Object.keys(cols)) {
                    out[key] = (r as Record<string, unknown>)[key];
                  }
                  return out;
                });
              },
            });
          };
          return { where: whereFn };
        },
      };
    },
    delete: () => ({
      where: async (pred: { __filter?: (r: Row) => boolean }) => {
        for (const [id, row] of [...rows.entries()]) {
          if (!pred.__filter || pred.__filter(row)) rows.delete(id);
        }
        return { rowCount: 0 };
      },
    }),
  };

  return { db, stagedFileUploadsTable };
});

vi.mock("drizzle-orm", () => {
  const wrap = (fn: (r: Row) => boolean) => ({ __filter: fn });
  return {
    eq: (col: string, val: unknown) =>
      wrap((r) => (r as Record<string, unknown>)[col] === val),
    and: (...preds: Array<{ __filter?: (r: Row) => boolean }>) =>
      wrap((r) => preds.every((p) => (p.__filter ? p.__filter(r) : true))),
    or: (...preds: Array<{ __filter?: (r: Row) => boolean }>) =>
      wrap((r) => preds.some((p) => (p.__filter ? p.__filter(r) : true))),
    lt: (col: string, val: Date) =>
      wrap((r) => {
        const v = (r as Record<string, unknown>)[col];
        return v instanceof Date && v.getTime() < val.getTime();
      }),
    isNull: (col: string) => wrap((r) => (r as Record<string, unknown>)[col] == null),
    sql: () => wrap(() => true),
    like: () => wrap(() => true),
  };
});

vi.mock("./getBaseUrl.js", () => ({
  getBaseUrl: () => "https://connect.example.test",
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  STAGED_FILE_MAX_BYTES,
  createStagedFileSession,
  putStagedFileByUploadToken,
  stageFileBytes,
  resolveUploadBytes,
  consumeStagedFile,
  markStagedFileConsumed,
  decodeFileBase64Public,
  StagedFileValidationError,
  StagedFileError,
} = await import("./staged-file-uploads.js");

const SCOPE = { firmId: "firm-a", userId: "user-a" };
const OTHER = { firmId: "firm-a", userId: "user-b" };

beforeEach(() => {
  rows.clear();
});

describe("decodeFileBase64Public", () => {
  it("decodes plain base64 and strips data-URI", () => {
    expect(decodeFileBase64Public(Buffer.from("%PDF").toString("base64")).toString()).toBe(
      "%PDF",
    );
    const raw = Buffer.from("hello").toString("base64");
    expect(decodeFileBase64Public(`data:application/pdf;base64,${raw}`).toString()).toBe(
      "hello",
    );
  });

  it("rejects empty content", () => {
    expect(() => decodeFileBase64Public("")).toThrow(StagedFileValidationError);
    expect(() => decodeFileBase64Public("   ")).toThrow(/empty/i);
  });
});

describe("resolveUploadBytes — base64 vs fileRef", () => {
  it("requires exactly one of base64 or fileRef", async () => {
    await expect(resolveUploadBytes(SCOPE, {})).rejects.toThrow(StagedFileValidationError);
    await expect(
      resolveUploadBytes(SCOPE, {
        fileContentBase64: Buffer.from("a").toString("base64"),
        fileRef: "fref_x",
      }),
    ).rejects.toThrow(/not both/i);
  });

  it("resolves base64 without staging", async () => {
    const resolved = await resolveUploadBytes(SCOPE, {
      fileContentBase64: Buffer.from("inline-pdf").toString("base64"),
    });
    expect(resolved.bytes.toString()).toBe("inline-pdf");
  });

  it("consumes fileRef once and rejects cross-user / empty / expired", async () => {
    const session = await createStagedFileSession(SCOPE, { fileName: "a.pdf" });
    expect(session.uploadUrl).toBe(
      `https://connect.example.test/upload/${session.uploadUrl.split("/upload/")[1]}`,
    );
    const token = session.uploadUrl.split("/upload/")[1]!;
    const pdf = Buffer.from("%PDF-1.4 staged");

    await expect(resolveUploadBytes(SCOPE, { fileRef: session.fileRef })).rejects.toThrow(
      /no content yet/i,
    );

    await putStagedFileByUploadToken(token, pdf, {
      fileName: "a.pdf",
      contentType: "application/pdf",
    });

    const resolved = await resolveUploadBytes(SCOPE, { fileRef: session.fileRef });
    expect(resolved.bytes.equals(pdf)).toBe(true);
    expect(resolved.fileName).toBe("a.pdf");

    await expect(resolveUploadBytes(SCOPE, { fileRef: session.fileRef })).rejects.toThrow(
      /already used/i,
    );

    const other = await createStagedFileSession(SCOPE, { fileName: "b.pdf" });
    const otherToken = other.uploadUrl.split("/upload/")[1]!;
    await putStagedFileByUploadToken(otherToken, Buffer.from("secret"), {
      fileName: "b.pdf",
    });
    await expect(
      resolveUploadBytes(OTHER, { fileRef: other.fileRef }),
    ).rejects.toThrow(/not found|not owned/i);

    const expired = await createStagedFileSession(SCOPE);
    const expToken = expired.uploadUrl.split("/upload/")[1]!;
    await putStagedFileByUploadToken(expToken, Buffer.from("late"), { fileName: "late.pdf" });
    const row = rows.get(expired.fileRef)!;
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(consumeStagedFile(SCOPE, expired.fileRef)).rejects.toThrow(/expired/i);
  });

  it("peek (consume:false) allows retry then markStagedFileConsumed", async () => {
    const session = await createStagedFileSession(SCOPE, { fileName: "retry.pdf" });
    const token = session.uploadUrl.split("/upload/")[1]!;
    const pdf = Buffer.from("%PDF-retry");
    await putStagedFileByUploadToken(token, pdf, { fileName: "retry.pdf" });

    const peek1 = await resolveUploadBytes(SCOPE, {
      fileRef: session.fileRef,
      consume: false,
    });
    expect(peek1.bytes.equals(pdf)).toBe(true);
    const peek2 = await resolveUploadBytes(SCOPE, {
      fileRef: session.fileRef,
      consume: false,
    });
    expect(peek2.bytes.equals(pdf)).toBe(true);

    await markStagedFileConsumed(SCOPE, session.fileRef, pdf.length);
    await expect(
      resolveUploadBytes(SCOPE, { fileRef: session.fileRef, consume: false }),
    ).rejects.toThrow(/already used/i);
  });

  it("creates one multi-drop batch URL for fileNames", async () => {
    const session = await createStagedFileSession(SCOPE, {
      fileNames: ["moran.pdf", "shaheen.pdf"],
    });
    expect(session.uploadUrl).toMatch(/\/upload\/batch\/ubatch_/);
    expect(session.fileRefs).toHaveLength(2);
    expect(session.files?.map((f) => f.fileName)).toEqual(["moran.pdf", "shaheen.pdf"]);
    expect(session.instructions).toMatch(/ALL files/i);
  });
});

describe("stageFileBytes / size / empty", () => {
  it("stages authenticated one-shot bytes", async () => {
    const result = await stageFileBytes(SCOPE, Buffer.from("one-shot"), {
      fileName: "doc.pdf",
      contentType: "application/pdf",
    });
    const resolved = await resolveUploadBytes(SCOPE, { fileRef: result.fileRef });
    expect(resolved.bytes.toString()).toBe("one-shot");
  });

  it("rejects empty and oversize bodies", async () => {
    await expect(
      stageFileBytes(SCOPE, Buffer.alloc(0), { fileName: "x.pdf" }),
    ).rejects.toThrow(StagedFileError);
    await expect(
      putStagedFileByUploadToken("missing-token", Buffer.from("x")),
    ).rejects.toThrow(StagedFileError);

    const huge = Buffer.alloc(STAGED_FILE_MAX_BYTES + 1, 1);
    await expect(stageFileBytes(SCOPE, huge, { fileName: "huge.pdf" })).rejects.toThrow(
      /limit/i,
    );
  });
});
