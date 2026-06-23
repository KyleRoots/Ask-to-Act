import { Router, type IRouter, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/**
 * POST /api/support
 * Open to authenticated portal users (no bearer token required — user identity
 * comes from the request body, pre-filled by Clerk on the client).
 * Body: { type, subject, message, userName, userEmail }
 */
router.post("/support", async (req: Request, res: Response) => {
  const { type, subject, message, userName, userEmail } = req.body as {
    type?: string;
    subject?: string;
    message?: string;
    userName?: string;
    userEmail?: string;
  };

  if (!type || !subject || !message || !userEmail) {
    res.status(400).json({ error: "type, subject, message, and userEmail are required" });
    return;
  }

  const validTypes = ["bug", "feature", "question"];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(", ")}` });
    return;
  }

  if (subject.trim().length < 3 || message.trim().length < 10) {
    res.status(400).json({ error: "Subject must be at least 3 characters; message at least 10." });
    return;
  }

  try {
    const { sendSupportEmail } = await import("../lib/emailService.js");
    await sendSupportEmail({
      type: type as "bug" | "feature" | "question",
      subject: subject.trim(),
      message: message.trim(),
      userName: userName?.trim() ?? "Portal user",
      userEmail: userEmail.trim(),
    });

    logger.info({ type, userEmail }, "Support email sent");
    res.json({ ok: true, message: "Your message has been received. We'll be in touch shortly." });
  } catch (err) {
    logger.error({ err, type, userEmail }, "Failed to send support email");
    res.status(500).json({ error: "Failed to send message. Please try again." });
  }
});

export default router;
