import { useState } from "react";
import { useUser, useClerk } from "@clerk/react";
import { useLocation } from "wouter";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";
const SUPPORT_EMAIL = "support@asktoact.ai";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type TicketType = "bug" | "feature" | "question";

const TYPES: { value: TicketType; label: string; icon: string; desc: string; subjectPrefix: string; bodyPrompt: string }[] = [
  {
    value: "bug",
    label: "Bug Report",
    icon: "🐛",
    desc: "Something isn't working as expected",
    subjectPrefix: "[Bug]",
    bodyPrompt: "What happened?\n\nWhat did you expect to happen?\n\nSteps to reproduce:\n1. \n2. \n3. ",
  },
  {
    value: "feature",
    label: "Feature Request",
    icon: "✨",
    desc: "Suggest an improvement or new capability",
    subjectPrefix: "[Feature Request]",
    bodyPrompt: "What would you like to see?\n\nHow would it help your workflow?\n\nAny additional context:",
  },
  {
    value: "question",
    label: "Question",
    icon: "❓",
    desc: "General question or clarification",
    subjectPrefix: "[Question]",
    bodyPrompt: "What would you like to know?\n\n",
  },
];

function LogoIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sup-lg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="55%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#sup-lg)" />
      <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
      <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
      <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Support() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [, navigate] = useLocation();
  const [ticketType, setTicketType] = useState<TicketType>("bug");

  const userEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const userName = user?.fullName ?? user?.firstName ?? user?.username ?? "";

  const selected = TYPES.find((t) => t.value === ticketType)!;

  function buildMailto() {
    const subject = encodeURIComponent(`${selected.subjectPrefix} `);
    const fromLine = userName
      ? `From: ${userName}${userEmail ? ` <${userEmail}>` : ""}\n\n`
      : userEmail
        ? `From: ${userEmail}\n\n`
        : "";
    const body = encodeURIComponent(`${fromLine}${selected.bodyPrompt}`);
    return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  }

  return (
    <div className="min-h-[100dvh]" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-8 py-4"
        style={{ background: "rgba(5,13,26,.9)", backdropFilter: "blur(14px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-1.5 text-sm transition-colors shrink-0"
            style={{ color: "#6B7A99" }}
          >
            ← <span className="hidden sm:inline">Dashboard</span>
          </button>
          <div className="w-px h-4" style={{ background: BORDER }} />
          <div className="flex items-center gap-2.5">
            <LogoIcon size={26} />
            <span className="text-base font-extrabold text-white tracking-tight" style={{ letterSpacing: "-0.02em" }}>
              Ask<span style={{ color: "#38BDF8" }}>To</span>Act
            </span>
          </div>
        </div>
        <button
          onClick={() => signOut({ redirectUrl: basePath || "/" })}
          className="text-sm px-3 py-1.5 rounded-xl transition-colors"
          style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
        >
          Sign out
        </button>
      </header>

      <main className="max-w-xl mx-auto px-5 sm:px-8 py-10">
        <div className="mb-8">
          <h1
            className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2"
            style={{ letterSpacing: "-0.03em" }}
          >
            Support & Feedback
          </h1>
          <p className="text-sm" style={{ color: "#4A5568" }}>
            We read everything. Pick a category, then click the button — your email client will open with a pre-filled message ready to send.
          </p>
        </div>

        {/* Type selector */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTicketType(t.value)}
              className="rounded-2xl p-4 text-left transition-all"
              style={{
                background: ticketType === t.value ? "rgba(79,70,229,.12)" : SURFACE,
                border: ticketType === t.value ? "1.5px solid rgba(79,70,229,.5)" : `1px solid ${BORDER}`,
              }}
            >
              <div className="text-xl mb-2">{t.icon}</div>
              <div className="text-xs font-semibold text-white mb-1">{t.label}</div>
              <div className="text-xs leading-relaxed hidden sm:block" style={{ color: "#4A5568" }}>{t.desc}</div>
            </button>
          ))}
        </div>

        {/* CTA */}
        <a
          href={buildMailto()}
          className="flex items-center justify-center gap-2.5 w-full rounded-xl py-3.5 text-sm font-bold text-white transition-all"
          style={{
            background: "linear-gradient(135deg,#4F46E5,#0EA5E9)",
            boxShadow: "0 4px 14px rgba(79,70,229,0.3)",
            textDecoration: "none",
          }}
        >
          <span>Open Email Client</span>
          <span style={{ opacity: 0.8 }}>→</span>
        </a>

        {/* Manual fallback */}
        <div className="mt-6 text-center">
          <p className="text-xs mb-2" style={{ color: "#3A4460" }}>
            Prefer to copy the address directly?
          </p>
          <button
            onClick={() => navigator.clipboard.writeText(SUPPORT_EMAIL)}
            className="text-sm font-medium transition-colors"
            style={{ color: "#38BDF8" }}
            title="Click to copy"
          >
            {SUPPORT_EMAIL}
          </button>
        </div>

        {/* Info note */}
        <div
          className="mt-8 rounded-xl px-5 py-4"
          style={{ background: "rgba(56,189,248,.04)", border: "1px solid rgba(56,189,248,.10)" }}
        >
          <p className="text-xs leading-relaxed" style={{ color: "#4A5568" }}>
            When you send, your message goes directly to our support inbox. We'll reply to your email — usually within one business day. For urgent issues, include as much detail as possible in the body.
          </p>
        </div>
      </main>
    </div>
  );
}
