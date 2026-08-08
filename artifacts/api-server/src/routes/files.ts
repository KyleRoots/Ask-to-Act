import { Router, type Request, type Response, type IRouter } from "express";
import { bearerAuth, requireBullhornFirm, attachFirmContext } from "../middlewares/bearer-auth.js";
import {
  STAGED_FILE_MAX_BYTES,
  StagedFileError,
  createStagedFileSession,
  getStagedFileMetaByUploadToken,
  putStagedFileByUploadToken,
  stageFileBytes,
} from "../lib/staged-file-uploads.js";
import { logger } from "../lib/logger.js";
import { nonceAttr } from "../lib/csp-nonce.js";

/**
 * JSON session create + authenticated one-shot staging under /api/files.
 * Browser HTML + raw PUT live on a separate router mounted before the global
 * 1mb JSON parser (see app.ts).
 */
const filesApiRouter: IRouter = Router();

function requireUserCaller(req: Request, res: Response): { userId: string; firmId: string } | null {
  if (req.caller?.kind !== "user" || !req.caller.firmId) {
    res.status(403).json({
      error:
        "Staged file uploads require your personal AskToAct user API key (same as write tools), not the shared service token.",
    });
    return null;
  }
  return { userId: req.caller.userId, firmId: req.caller.firmId };
}

function fileNameFromHeaders(req: Request): string | undefined {
  const raw = req.headers["x-file-name"];
  if (typeof raw === "string" && raw.trim()) {
    try {
      return decodeURIComponent(raw.trim());
    } catch {
      return raw.trim();
    }
  }
  return undefined;
}

/**
 * POST /api/files/uploads — create empty staging session { fileRef, uploadUrl }.
 * For authenticated one-shot byte staging use POST /api/files/uploads/content.
 */
filesApiRouter.post(
  "/files/uploads",
  bearerAuth,
  requireBullhornFirm,
  attachFirmContext,
  async (req: Request, res: Response) => {
    const scope = requireUserCaller(req, res);
    if (!scope) return;

    try {
      const body = (req.body ?? {}) as { fileName?: unknown; contentType?: unknown };
      const fileName = typeof body.fileName === "string" ? body.fileName : undefined;
      const contentType = typeof body.contentType === "string" ? body.contentType : undefined;
      const session = await createStagedFileSession(scope, { fileName, contentType });
      res.status(201).json(session);
    } catch (err) {
      if (err instanceof StagedFileError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error({ err }, "files/uploads session create failed");
      res.status(500).json({ error: "Could not create file upload session." });
    }
  },
);

/**
 * POST /api/files/uploads/content — Bearer + raw bytes + X-File-Name → { fileRef }.
 * Mounted with express.raw in app.ts before the global 1mb JSON parser.
 */
export async function handleAuthenticatedBinaryStage(
  req: Request,
  res: Response,
): Promise<void> {
  const scope = requireUserCaller(req, res);
  if (!scope) return;

  try {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({
        error: "Expected raw file body with header X-File-Name.",
      });
      return;
    }
    const fileName = fileNameFromHeaders(req);
    if (!fileName) {
      res.status(400).json({ error: "Missing X-File-Name header for binary upload." });
      return;
    }
    const ct = String(req.headers["content-type"] ?? "");
    const result = await stageFileBytes(scope, body, {
      fileName,
      contentType: ct ? ct.split(";")[0]?.trim() : undefined,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof StagedFileError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error({ err }, "files/uploads/content failed");
    res.status(500).json({ error: "Could not stage file upload." });
  }
}

export default filesApiRouter;

/** Browser drop page + raw PUT /upload/:token — mount before global JSON parser. */
export const uploadBrowserRouter: IRouter = Router();

uploadBrowserRouter.get("/upload/:token", async (req: Request, res: Response) => {
  const token = String(req.params["token"] ?? "");
  const meta = token ? await getStagedFileMetaByUploadToken(token) : null;
  if (!meta) {
    res.status(404).type("html").send(uploadPageHtml({ state: "missing" }));
    return;
  }
  if (meta.consumed) {
    res.status(410).type("html").send(uploadPageHtml({ state: "consumed" }));
    return;
  }
  if (meta.expired) {
    res.status(410).type("html").send(uploadPageHtml({ state: "expired" }));
    return;
  }
  if (meta.hasContent) {
    res.status(200).type("html").send(
      uploadPageHtml({
        state: "ready",
        fileName: meta.fileName,
        fileRef: meta.fileRef,
      }),
    );
    return;
  }
  res.status(200).type("html").send(
    uploadPageHtml({
      state: "awaiting",
      fileName: meta.fileName,
      maxBytes: STAGED_FILE_MAX_BYTES,
    }),
  );
});

uploadBrowserRouter.put("/upload/:token", async (req: Request, res: Response) => {
  const token = String(req.params["token"] ?? "");
  try {
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({
        error: "Expected raw file body. Use Content-Type: application/octet-stream (or the file MIME).",
      });
      return;
    }
    const fileName = fileNameFromHeaders(req);
    const ct = String(req.headers["content-type"] ?? "");
    const result = await putStagedFileByUploadToken(token, body, {
      fileName,
      contentType: ct ? ct.split(";")[0]?.trim() : undefined,
    });
    res.status(200).json({
      ok: true,
      ...result,
      next: "Return to chat and tell the assistant the file is uploaded — it will attach with fileRef.",
    });
  } catch (err) {
    if (err instanceof StagedFileError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    logger.error({ err }, "upload/:token PUT failed");
    res.status(500).json({ error: "Could not store uploaded file." });
  }
});

function uploadPageHtml(opts: {
  state: "awaiting" | "ready" | "missing" | "expired" | "consumed";
  fileName?: string | null;
  fileRef?: string;
  maxBytes?: number;
}): string {
  const title =
    opts.state === "awaiting"
      ? "Upload file for AskToAct"
      : opts.state === "ready"
        ? "File ready"
        : "Upload unavailable";
  const maxLabel = opts.maxBytes
    ? `${Math.round(opts.maxBytes / (1024 * 1024))} MB`
    : "25 MB";
  const hint =
    opts.state === "awaiting"
      ? `Drop the exact PDF or document here (max ${maxLabel}). Do not compress or convert it. Then return to ChatGPT/Cursor.`
      : opts.state === "ready"
        ? `Saved${opts.fileName ? ` as ${escapeHtml(opts.fileName)}` : ""}. Return to chat — the assistant will attach it with fileRef.`
        : opts.state === "expired"
          ? "This link expired. Ask the assistant for a new upload link."
          : opts.state === "consumed"
            ? "This file was already attached. Ask the assistant for a new link if you need to upload again."
            : "This upload link is invalid. Ask the assistant for a new one.";

  const dropUi =
    opts.state === "awaiting"
      ? `<label class="drop" id="drop">
  <input type="file" id="file" hidden />
  <strong>Drop file here</strong>
  <span>or click to choose</span>
</label>
<p class="status" id="status" role="status"></p>`
      : "";

  const script =
    opts.state === "awaiting"
      ? `<script${nonceAttr()}>
const drop = document.getElementById("drop");
const input = document.getElementById("file");
const status = document.getElementById("status");
function setStatus(t, ok){ status.textContent = t; status.dataset.ok = ok ? "1" : "0"; }
async function send(file){
  setStatus("Uploading " + file.name + "…", true);
  try {
    const res = await fetch(location.pathname, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
      },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("Upload failed (" + res.status + ")"));
    setStatus("Uploaded. Return to chat and tell the assistant it is ready.", true);
    drop.classList.add("done");
  } catch (e) {
    setStatus(e && e.message ? e.message : "Upload failed", false);
  }
}
drop.addEventListener("click", () => input.click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) send(f);
});
input.addEventListener("change", () => { if (input.files && input.files[0]) send(input.files[0]); });
</script>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style${nonceAttr()}>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    main{max-width:420px;width:100%}
    .logo{font-size:15px;font-weight:800;letter-spacing:-0.02em;margin-bottom:20px;color:#f8fafc}
    .logo span{color:#38BDF8}
    h1{font-size:22px;font-weight:600;margin-bottom:10px}
    p{font-size:14px;line-height:1.55;color:#8a99b3;margin-bottom:18px}
    .drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:160px;border:1.5px dashed #334155;border-radius:14px;background:#111827;cursor:pointer;padding:24px;text-align:center}
    .drop strong{color:#f8fafc;font-size:15px}
    .drop span{color:#64748b;font-size:13px}
    .drop.over{border-color:#38BDF8;background:#0f172a}
    .drop.done{border-color:#34d399;opacity:.85;pointer-events:none}
    .status{margin-top:14px;font-size:13px;color:#94a3b8}
    .status[data-ok="0"]{color:#f87171}
    .status[data-ok="1"]{color:#34d399}
  </style>
</head>
<body>
  <main>
    <div class="logo">Ask<span>To</span>Act</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${hint}</p>
    ${dropUi}
  </main>
  ${script}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
