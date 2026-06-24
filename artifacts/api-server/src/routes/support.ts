import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { logger } from "../lib/logger.js";
import { requireClerkUser } from "../middlewares/clerk-user.js";

const router: IRouter = Router();

/**
 * Stricter limiter for the public, unauthenticated help endpoint to deter abuse:
 * a handful of requests per IP per 10 minutes is plenty for a real person.
 */
const helpLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many help requests. Please wait a few minutes and try again." },
});

/**
 * POST /api/support
 * Requires a valid Clerk session (portal users only). Identity is derived
 * server-side from the Clerk session — body-supplied name/email are ignored
 * to prevent spoofing.
 * Body: { type, subject, message }
 */
router.post("/support", requireClerkUser, async (req: Request, res: Response) => {
  const { type, subject, message } = req.body as {
    type?: string;
    subject?: string;
    message?: string;
  };

  const userName = req.portalUser!.name ?? "Portal user";
  const userEmail = req.portalUser!.email ?? "";

  if (!type || !subject || !message) {
    res.status(400).json({ error: "type, subject, and message are required" });
    return;
  }

  if (!userEmail) {
    res.status(400).json({ error: "No email address on your account — contact support@asktoact.com directly." });
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

/**
 * POST /api/support/help
 * PUBLIC (no auth) — backs the "Ask for help with setup" form on the connector
 * setup page, which is shown to users who are not signed into the portal. The
 * message is sent via SendGrid to the support inbox (SUPPORT_EMAIL).
 * Body: { name?, email, message, website? } — `website` is a honeypot.
 */
router.post("/support/help", helpLimiter, async (req: Request, res: Response) => {
  const { name, email, message, website } = req.body as {
    name?: string;
    email?: string;
    message?: string;
    website?: string;
  };

  // Honeypot: real users never fill this hidden field. Pretend success, send nothing.
  if (typeof website === "string" && website.trim().length > 0) {
    res.json({ ok: true, message: "Your message has been received. We'll be in touch shortly." });
    return;
  }

  const cleanEmail = (email ?? "").trim();
  const cleanMessage = (message ?? "").trim();
  const cleanName = (name ?? "").trim() || "Recruiter";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    res.status(400).json({ error: "Please enter a valid email address so we can reply." });
    return;
  }
  if (cleanMessage.length < 10) {
    res.status(400).json({ error: "Please describe what you need help with (at least 10 characters)." });
    return;
  }
  if (cleanMessage.length > 5000) {
    res.status(400).json({ error: "Message is too long — please keep it under 5000 characters." });
    return;
  }

  try {
    const { sendSupportEmail } = await import("../lib/emailService.js");
    await sendSupportEmail({
      type: "question",
      subject: `Connector setup help — ${cleanName}`,
      message: cleanMessage,
      userName: cleanName,
      userEmail: cleanEmail,
    });

    logger.info({ userEmail: cleanEmail }, "Connector setup help request sent");
    res.json({ ok: true, message: "Your message has been sent — our team will reach out by email shortly." });
  } catch (err) {
    logger.error({ err }, "Failed to send connector setup help request");
    res.status(500).json({ error: "Failed to send message. Please try again." });
  }
});

export default router;
