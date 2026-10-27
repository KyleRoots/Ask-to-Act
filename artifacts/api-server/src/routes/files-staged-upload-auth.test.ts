import { beforeEach, describe, expect, it, vi } from "vitest";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";

/**
 * requireUserCaller is not exported. These tests reach it through the two
 * production callers: POST /api/files/uploads on the files router, and
 * handleAuthenticatedBinaryStage (the handler app.ts mounts at
 * POST /api/files/uploads/content).
 *
 * bearerAuth and requireBullhornFirm are stubbed so a missing caller, a
 * service caller, and a user with no firm actually arrive at that check.
 * The real middleware returns a different status and body first, which would
 * hide a regression in the upload gate.
 */

const PERSONAL_KEY_ERROR =
  "Staged file uploads require your personal AskToAct user API key (same as write tools), not the shared service token.";

const staging = vi.hoisted(() => ({
  createStagedFileSession: vi.fn(),
  stageFileBytes: vi.fn(),
  getStagedBatchById: vi.fn(),
  getStagedFileMetaByUploadToken: vi.fn(),
  putStagedFileByUploadToken: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/staged-file-uploads.js", () => {
  class StagedFileError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = "StagedFileError";
      this.statusCode = statusCode;
    }
  }
  return {
    STAGED_FILE_MAX_BYTES: 25 * 1024 * 1024,
    StagedFileError,
    createStagedFileSession: staging.createStagedFileSession,
    getStagedBatchById: staging.getStagedBatchById,
    getStagedFileMetaByUploadToken: staging.getStagedFileMetaByUploadToken,
    putStagedFileByUploadToken: staging.putStagedFileByUploadToken,
    stageFileBytes: staging.stageFileBytes,
  };
});

vi.mock("../middlewares/bearer-auth.js", () => ({
  bearerAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireBullhornFirm: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  attachFirmContext: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { default: filesApiRouter, handleAuthenticatedBinaryStage } =
  await import("./files.js");

type TestCaller =
  | undefined
  | { kind: "service" }
  | { kind: "user"; userId: string; firmId: string | null };

let caller: TestCaller;

function assignCaller(req: Request, _res: Response, next: NextFunction): void {
  if (caller) req.caller = caller;
  next();
}

const jsonApp = express();
jsonApp.use(express.json({ limit: "1mb" }));
jsonApp.use(assignCaller);
jsonApp.use("/api", filesApiRouter);

// Same handler mount as app.ts: raw body, then handleAuthenticatedBinaryStage.
const binaryApp = express();
binaryApp.post(
  "/api/files/uploads/content",
  express.raw({ type: () => true, limit: "25mb" }),
  assignCaller,
  (req, res) => {
    void handleAuthenticatedBinaryStage(req, res);
  },
);

// The production raw parser always yields a Buffer. This app skips it so a
// parsed JSON body can prove the post-gate non-buffer rejection.
const binaryJsonApp = express();
binaryJsonApp.post(
  "/api/files/uploads/content",
  express.json({ limit: "1mb" }),
  assignCaller,
  (req, res) => {
    void handleAuthenticatedBinaryStage(req, res);
  },
);

const rejectedCallers: Array<[string, TestCaller]> = [
  ["no caller", undefined],
  ["a service caller", { kind: "service" }],
  [
    "a user caller with a null firmId",
    { kind: "user", userId: "user_1", firmId: null },
  ],
  [
    "a user caller with an empty firmId",
    { kind: "user", userId: "user_1", firmId: "" },
  ],
];

function expectNoStaging(): void {
  expect(staging.createStagedFileSession).not.toHaveBeenCalled();
  expect(staging.stageFileBytes).not.toHaveBeenCalled();
}

beforeEach(() => {
  caller = undefined;
  staging.createStagedFileSession.mockReset();
  staging.stageFileBytes.mockReset();
  staging.createStagedFileSession.mockResolvedValue({
    fileRef: "fref_should_not_be_created",
    uploadUrl: "https://example.test/upload/should-not-exist",
  });
  staging.stageFileBytes.mockResolvedValue({
    fileRef: "fref_should_not_be_written",
  });
});

describe("POST /api/files/uploads requireUserCaller", () => {
  it.each(rejectedCallers)(
    "returns 403 for %s and does not create a staged upload",
    async (_label, nextCaller) => {
      caller = nextCaller;
      const res = await request(jsonApp)
        .post("/api/files/uploads")
        .send({ fileName: "resume.pdf" });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: PERSONAL_KEY_ERROR });
      expectNoStaging();
    },
  );

  it("lets a user caller with userId and firmId create a session", async () => {
    caller = { kind: "user", userId: "user_9", firmId: "firm_9" };
    const session = {
      fileRef: "fref_ok",
      uploadUrl: "https://example.test/upload/uptk_ok",
    };
    staging.createStagedFileSession.mockResolvedValue(session);

    const res = await request(jsonApp)
      .post("/api/files/uploads")
      .send({ fileName: "resume.pdf" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(session);
    expect(staging.createStagedFileSession).toHaveBeenCalledTimes(1);
    expect(staging.createStagedFileSession.mock.calls[0]?.[0]).toEqual({
      userId: "user_9",
      firmId: "firm_9",
    });
    expect(staging.stageFileBytes).not.toHaveBeenCalled();
  });
});

describe("POST /api/files/uploads/content requireUserCaller", () => {
  it.each(rejectedCallers)(
    "returns 403 for %s and does not write bytes",
    async (_label, nextCaller) => {
      caller = nextCaller;
      const res = await request(binaryApp)
        .post("/api/files/uploads/content")
        .set("Content-Type", "application/pdf")
        .set("X-File-Name", "resume.pdf")
        .send(Buffer.from("%PDF-1.4 resume"));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: PERSONAL_KEY_ERROR });
      expectNoStaging();
    },
  );

  it("returns 400 for a non-buffer body after a firm-bound user passes the gate", async () => {
    caller = { kind: "user", userId: "user_9", firmId: "firm_9" };

    const res = await request(binaryJsonApp)
      .post("/api/files/uploads/content")
      .send({ fileName: "resume.pdf" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Expected raw file body with header X-File-Name.",
    });
    expectNoStaging();
  });

  it("returns 400 when a firm-bound user sends a buffer without X-File-Name", async () => {
    caller = { kind: "user", userId: "user_9", firmId: "firm_9" };

    const res = await request(binaryApp)
      .post("/api/files/uploads/content")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.4 resume"));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing X-File-Name header for binary upload.",
    });
    expectNoStaging();
  });
});
