import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, stagedFileUploadsTable } from "@workspace/db";
import { getBaseUrl } from "./getBaseUrl.js";
import { logger } from "./logger.js";

/** Aligned with MCP JSON body limit for base64 uploads. */
export const STAGED_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Staging TTL — enough for a user to open the upload link once. */
export const STAGED_FILE_TTL_MS = 60 * 60 * 1000;

export type StagedFileScope = {
  firmId: string;
  userId: string;
};

export type StagedFileSession = {
  fileRef: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  instructions: string;
  /** Present when multiple files share one drop page. */
  fileRefs?: string[];
  files?: Array<{ fileRef: string; fileName: string | null; uploadToken?: string }>;
};

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("hex")}`;
}

function uploadUrlForToken(uploadToken: string): string {
  return `${getBaseUrl()}/upload/${uploadToken}`;
}

function uploadUrlForBatch(batchId: string): string {
  return `${getBaseUrl()}/upload/batch/${batchId}`;
}

const SINGLE_FILE_INSTRUCTIONS =
  "Chat attachments are for matching/context only — ChatGPT usually cannot inject PDF bytes into tools. Open uploadUrl once in a browser and drop the exact file there (do not compress or convert). That one drop is the real upload. Then call upload_file_to_record or create_candidate_from_resume with this fileRef (omit fileContentBase64).";

const MULTI_FILE_INSTRUCTIONS =
  "Chat attachments are for matching/context only — ChatGPT usually cannot inject PDF bytes into tools. Open uploadUrl once and drop ALL files on that single page (one browser visit). Then call upload_file_to_record / create_candidate_from_resume once per fileRef (omit fileContentBase64).";

/**
 * Creates empty staging slot(s) and returns a one-time browser upload URL.
 * Pass `fileNames` (2+) for one multi-drop page; otherwise a single-file URL.
 * The caller later passes each `fileRef` to upload_file_to_record /
 * create_candidate_from_resume after the user puts bytes.
 */
export async function createStagedFileSession(
  scope: StagedFileScope,
  opts?: {
    fileName?: string;
    fileNames?: string[];
    contentType?: string;
  },
): Promise<StagedFileSession> {
  const names = (opts?.fileNames?.length
    ? opts.fileNames
    : opts?.fileName
      ? [opts.fileName]
      : [undefined]
  ).map((n) => (typeof n === "string" && n.trim() ? n.trim() : null));

  const expiresAt = new Date(Date.now() + STAGED_FILE_TTL_MS);
  const multi = names.length > 1;
  const batchId = multi ? newId("ubatch") : null;

  const created: Array<{
    fileRef: string;
    uploadToken: string;
    fileName: string | null;
  }> = [];

  for (const fileName of names) {
    const fileRef = newId("fref");
    const uploadToken = newId("uptk");
    await db.insert(stagedFileUploadsTable).values({
      id: fileRef,
      firmId: scope.firmId,
      userId: scope.userId,
      uploadToken,
      batchId,
      fileName,
      contentType: opts?.contentType ?? null,
      expiresAt,
    });
    created.push({ fileRef, uploadToken, fileName });
  }

  void purgeExpiredStagedFiles().catch((err) => {
    logger.warn({ err }, "staged-file: purge expired failed");
  });

  const primary = created[0]!;
  if (multi && batchId) {
    return {
      fileRef: primary.fileRef,
      fileRefs: created.map((c) => c.fileRef),
      files: created.map((c) => ({
        fileRef: c.fileRef,
        fileName: c.fileName,
      })),
      uploadUrl: uploadUrlForBatch(batchId),
      expiresAt: expiresAt.toISOString(),
      maxBytes: STAGED_FILE_MAX_BYTES,
      instructions: MULTI_FILE_INSTRUCTIONS,
    };
  }

  return {
    fileRef: primary.fileRef,
    uploadUrl: uploadUrlForToken(primary.uploadToken),
    expiresAt: expiresAt.toISOString(),
    maxBytes: STAGED_FILE_MAX_BYTES,
    instructions: SINGLE_FILE_INSTRUCTIONS,
  };
}

/**
 * Stores raw bytes into an existing staging slot identified by upload token
 * (browser one-time URL). Token must belong to an unconsumed, non-expired row.
 */
export async function putStagedFileByUploadToken(
  uploadToken: string,
  bytes: Buffer,
  meta?: { fileName?: string; contentType?: string },
): Promise<{ fileRef: string; fileName: string; sizeBytes: number; expiresAt: string }> {
  assertNonEmptyBytes(bytes);
  assertWithinSizeCap(bytes);

  const [row] = await db
    .select({
      id: stagedFileUploadsTable.id,
      expiresAt: stagedFileUploadsTable.expiresAt,
      consumedAt: stagedFileUploadsTable.consumedAt,
      fileName: stagedFileUploadsTable.fileName,
    })
    .from(stagedFileUploadsTable)
    .where(eq(stagedFileUploadsTable.uploadToken, uploadToken))
    .limit(1);

  if (!row) {
    throw new StagedFileError(404, "Upload link not found or already used.");
  }
  if (row.consumedAt) {
    throw new StagedFileError(410, "This upload was already attached to a Bullhorn record.");
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new StagedFileError(410, "This upload link has expired. Ask the assistant for a new one.");
  }

  const fileName = meta?.fileName?.trim() || row.fileName || "upload.bin";
  const [updated] = await db
    .update(stagedFileUploadsTable)
    .set({
      content: bytes,
      sizeBytes: bytes.length,
      fileName,
      contentType: meta?.contentType ?? null,
    })
    .where(
      and(
        eq(stagedFileUploadsTable.id, row.id),
        isNull(stagedFileUploadsTable.consumedAt),
      ),
    )
    .returning({
      id: stagedFileUploadsTable.id,
      expiresAt: stagedFileUploadsTable.expiresAt,
    });

  if (!updated) {
    throw new StagedFileError(409, "Could not store file — try a fresh upload link.");
  }

  return {
    fileRef: updated.id,
    fileName,
    sizeBytes: bytes.length,
    expiresAt: updated.expiresAt.toISOString(),
  };
}

/**
 * Authenticated one-shot: create a staging row and store bytes immediately.
 * Returns fileRef for subsequent MCP upload tools (no browser step).
 */
export async function stageFileBytes(
  scope: StagedFileScope,
  bytes: Buffer,
  meta: { fileName: string; contentType?: string },
): Promise<{ fileRef: string; fileName: string; sizeBytes: number; expiresAt: string }> {
  assertNonEmptyBytes(bytes);
  assertWithinSizeCap(bytes);

  const fileName = meta.fileName.trim();
  if (!fileName) {
    throw new StagedFileError(400, "X-File-Name (or fileName) is required.");
  }

  const fileRef = newId("fref");
  const uploadToken = newId("uptk");
  const expiresAt = new Date(Date.now() + STAGED_FILE_TTL_MS);

  await db.insert(stagedFileUploadsTable).values({
    id: fileRef,
    firmId: scope.firmId,
    userId: scope.userId,
    uploadToken,
    fileName,
    contentType: meta.contentType ?? null,
    content: bytes,
    sizeBytes: bytes.length,
    expiresAt,
  });

  void purgeExpiredStagedFiles().catch((err) => {
    logger.warn({ err }, "staged-file: purge expired failed");
  });

  return {
    fileRef,
    fileName,
    sizeBytes: bytes.length,
    expiresAt: expiresAt.toISOString(),
  };
}

export type ResolvedUploadBytes = {
  bytes: Buffer;
  fileName?: string;
  contentType?: string;
};

/**
 * Resolves exact file bytes from either inline base64 or a firm/user-scoped
 * fileRef. By default consumes (and clears) the staging row when fileRef is
 * used — pass `consume: false` to peek so a failed Bullhorn upload can retry.
 */
export async function resolveUploadBytes(
  scope: StagedFileScope,
  args: {
    fileContentBase64?: string | null;
    fileRef?: string | null;
    label?: string;
    /** When false, load fileRef bytes without marking consumed (default true). */
    consume?: boolean;
  },
): Promise<ResolvedUploadBytes> {
  const label = args.label ?? "File";
  const b64 = typeof args.fileContentBase64 === "string" ? args.fileContentBase64.trim() : "";
  const ref = typeof args.fileRef === "string" ? args.fileRef.trim() : "";
  const consume = args.consume !== false;

  if (b64 && ref) {
    throw new StagedFileValidationError(
      `Provide either fileContentBase64 or fileRef for ${label}, not both.`,
    );
  }
  if (!b64 && !ref) {
    throw new StagedFileValidationError(
      `${label} requires fileContentBase64 (chat attachment bytes) or fileRef (from create_file_upload_link / staged upload).`,
    );
  }

  if (b64) {
    return { bytes: decodeFileBase64Public(b64, label) };
  }

  return consumeStagedFile(scope, ref, label, { consume });
}

/**
 * Loads staged bytes for the calling firm/user. When `consume` is true (default),
 * marks the row consumed and clears content so the fileRef cannot be replayed.
 */
export async function consumeStagedFile(
  scope: StagedFileScope,
  fileRef: string,
  label = "File",
  opts?: { consume?: boolean },
): Promise<ResolvedUploadBytes> {
  const shouldConsume = opts?.consume !== false;
  const [row] = await db
    .select({
      id: stagedFileUploadsTable.id,
      firmId: stagedFileUploadsTable.firmId,
      userId: stagedFileUploadsTable.userId,
      content: stagedFileUploadsTable.content,
      fileName: stagedFileUploadsTable.fileName,
      contentType: stagedFileUploadsTable.contentType,
      expiresAt: stagedFileUploadsTable.expiresAt,
      consumedAt: stagedFileUploadsTable.consumedAt,
      sizeBytes: stagedFileUploadsTable.sizeBytes,
    })
    .from(stagedFileUploadsTable)
    .where(eq(stagedFileUploadsTable.id, fileRef))
    .limit(1);

  if (!row || row.firmId !== scope.firmId || row.userId !== scope.userId) {
    throw new StagedFileValidationError(
      `${label} fileRef not found (or not owned by this user). Create a new upload link and try again.`,
    );
  }
  if (row.consumedAt) {
    throw new StagedFileValidationError(
      `${label} fileRef was already used. Create a new upload link and upload the file again.`,
    );
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new StagedFileValidationError(
      `${label} fileRef has expired. Create a new upload link and upload the file again.`,
    );
  }
  if (!row.content || row.content.length === 0) {
    throw new StagedFileValidationError(
      `${label} fileRef has no content yet. Open the uploadUrl, drop the file, then retry with the same fileRef.`,
    );
  }

  const bytes = normalizeStagedBytes(row.content);
  assertNonEmptyBytes(bytes, label);

  if (shouldConsume) {
    await markStagedFileConsumed(scope, row.id, bytes.length);
  }

  return {
    bytes,
    fileName: row.fileName ?? undefined,
    contentType: row.contentType ?? undefined,
  };
}

/** Marks a previously peeked fileRef as consumed and clears stored bytes. */
export async function markStagedFileConsumed(
  scope: StagedFileScope,
  fileRef: string,
  sizeBytes?: number,
): Promise<void> {
  await db
    .update(stagedFileUploadsTable)
    .set({
      consumedAt: new Date(),
      content: null,
      ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
    })
    .where(
      and(
        eq(stagedFileUploadsTable.id, fileRef),
        eq(stagedFileUploadsTable.firmId, scope.firmId),
        eq(stagedFileUploadsTable.userId, scope.userId),
        isNull(stagedFileUploadsTable.consumedAt),
      ),
    );
}

/** Coerce pg/drizzle bytea (Buffer | Uint8Array | number[]) to Buffer. */
function normalizeStagedBytes(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (Array.isArray(content)) return Buffer.from(content);
  if (typeof content === "string") {
    // node-pg sometimes returns hex-encoded bytea as \x...
    if (content.startsWith("\\x")) return Buffer.from(content.slice(2), "hex");
    return Buffer.from(content, "binary");
  }
  return Buffer.from(content as ArrayBuffer);
}

export async function getStagedFileMetaByUploadToken(uploadToken: string): Promise<{
  fileRef: string;
  fileName: string | null;
  hasContent: boolean;
  expiresAt: Date;
  expired: boolean;
  consumed: boolean;
} | null> {
  const [row] = await db
    .select({
      id: stagedFileUploadsTable.id,
      fileName: stagedFileUploadsTable.fileName,
      sizeBytes: stagedFileUploadsTable.sizeBytes,
      expiresAt: stagedFileUploadsTable.expiresAt,
      consumedAt: stagedFileUploadsTable.consumedAt,
    })
    .from(stagedFileUploadsTable)
    .where(eq(stagedFileUploadsTable.uploadToken, uploadToken))
    .limit(1);

  if (!row) return null;
  return {
    fileRef: row.id,
    fileName: row.fileName,
    hasContent: (row.sizeBytes ?? 0) > 0,
    expiresAt: row.expiresAt,
    expired: row.expiresAt.getTime() <= Date.now(),
    consumed: row.consumedAt != null,
  };
}

export type StagedBatchSlot = {
  fileRef: string;
  uploadToken: string;
  fileName: string | null;
  hasContent: boolean;
  consumed: boolean;
};

export async function getStagedBatchById(batchId: string): Promise<{
  batchId: string;
  expiresAt: Date;
  expired: boolean;
  slots: StagedBatchSlot[];
} | null> {
  const rows = await db
    .select({
      id: stagedFileUploadsTable.id,
      uploadToken: stagedFileUploadsTable.uploadToken,
      fileName: stagedFileUploadsTable.fileName,
      sizeBytes: stagedFileUploadsTable.sizeBytes,
      expiresAt: stagedFileUploadsTable.expiresAt,
      consumedAt: stagedFileUploadsTable.consumedAt,
    })
    .from(stagedFileUploadsTable)
    .where(eq(stagedFileUploadsTable.batchId, batchId));

  if (!rows.length) return null;
  const expiresAt = rows.reduce(
    (min, r) => (r.expiresAt.getTime() < min.getTime() ? r.expiresAt : min),
    rows[0]!.expiresAt,
  );
  return {
    batchId,
    expiresAt,
    expired: expiresAt.getTime() <= Date.now(),
    slots: rows.map((r) => ({
      fileRef: r.id,
      uploadToken: r.uploadToken,
      fileName: r.fileName,
      hasContent: (r.sizeBytes ?? 0) > 0,
      consumed: r.consumedAt != null,
    })),
  };
}

export async function purgeExpiredStagedFiles(): Promise<number> {
  const result = await db
    .delete(stagedFileUploadsTable)
    .where(
      or(
        lt(stagedFileUploadsTable.expiresAt, new Date()),
        // Also drop long-consumed rows (content already null).
        and(
          sql`${stagedFileUploadsTable.consumedAt} is not null`,
          lt(stagedFileUploadsTable.consumedAt, new Date(Date.now() - STAGED_FILE_TTL_MS)),
        ),
      ),
    );
  // drizzle delete rowCount varies by driver; ignore precise count.
  return typeof (result as { rowCount?: number }).rowCount === "number"
    ? ((result as { rowCount?: number }).rowCount ?? 0)
    : 0;
}

export class StagedFileError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "StagedFileError";
  }
}

/** Validation failures for tool args / fileRef resolution (map to user-facing tool errors). */
export class StagedFileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagedFileValidationError";
  }
}

function assertWithinSizeCap(bytes: Buffer): void {
  if (bytes.length > STAGED_FILE_MAX_BYTES) {
    throw new StagedFileError(
      413,
      `File exceeds the ${STAGED_FILE_MAX_BYTES} byte limit (${bytes.length} bytes).`,
    );
  }
}

function assertNonEmptyBytes(bytes: Buffer, label = "File"): void {
  if (!bytes || bytes.length === 0) {
    throw new StagedFileError(400, `${label} content is empty — provide the real file bytes.`);
  }
}

/**
 * Same data-URI-tolerant decode as Bullhorn uploads. Exported for tests and
 * resolveUploadBytes so empty base64 fails with a clear validation error.
 */
export function decodeFileBase64Public(base64: string, label = "File"): Buffer {
  const stripped = base64.replace(/^data:[^;,]*;base64,/i, "").trim();
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length === 0) {
    throw new StagedFileValidationError(
      `${label} content is empty — provide base64-encoded file bytes or use fileRef after staging.`,
    );
  }
  return bytes;
}
