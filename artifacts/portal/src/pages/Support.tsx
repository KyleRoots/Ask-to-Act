import { useState } from "react";
import { useUser, useClerk } from "@clerk/react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Toaster } from "@/components/ui/toaster";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";
const SUPPORT_EMAIL = "support@asktoact.ai";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type TicketType = "bug" | "feature" | "question";

const TYPES: { value: TicketType; label: string; icon: string; desc: string }[] = [
  { value: "bug", label: "Bug Report", icon: "🐛", desc: "Something isn't working as expected" },
  { value: "feature", label: "Feature Request", icon: "✨", desc: "Suggest an improvement or new capability" },
  { value: "question", label: "Question", icon: "❓", desc: "General question or clarification" },
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
  const { toast } = useToast();

  const [ticketType, setTicketType] = useState<TicketType>("bug");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const userEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const userName = user?.fullName ?? user?.firstName ?? user?.username ?? "Portal user";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;

    setIsSubmitting(true);
    try {
      const resp = await fetch(`${basePath}/api/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: ticketType, subject, message, userName, userEmail }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to send");
      }

      setSubmitted(true);
    } catch (err) {
      toast({
        title: "Couldn't send message",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
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

      <main className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        {!submitted ? (
          <>
            <div className="mb-8">
              <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2"
                style={{ letterSpacing: "-0.03em" }}>
                Support & Feedback
              </h1>
              <p className="text-sm" style={{ color: "#4A5568" }}>
                Report a bug, request a feature, or ask a question. We read everything.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Type selector */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "#6B7A99" }}>
                  Type
                </label>
                <div className="grid grid-cols-3 gap-3">
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
              </div>

              {/* Subject */}
              <div>
                <label htmlFor="subject" className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#6B7A99" }}>
                  Subject
                </label>
                <input
                  id="subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Brief description of your issue or idea"
                  required
                  minLength={3}
                  className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none transition-colors"
                  style={{ background: SURFACE, border: `1.5px solid ${BORDER}` }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = BORDER; }}
                />
              </div>

              {/* Message */}
              <div>
                <label htmlFor="message" className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "#6B7A99" }}>
                  Details
                </label>
                <textarea
                  id="message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={
                    ticketType === "bug"
                      ? "What happened? What did you expect? Steps to reproduce..."
                      : ticketType === "feature"
                        ? "What would you like to see? How would it help your workflow?"
                        : "What would you like to know?"
                  }
                  required
                  minLength={10}
                  rows={6}
                  className="w-full rounded-xl px-4 py-3 text-sm text-white placeholder-[#3A4460] outline-none resize-y transition-colors"
                  style={{ background: SURFACE, border: `1.5px solid ${BORDER}` }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "#4F46E5"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = BORDER; }}
                />
              </div>

              {/* Submitter info (read-only) */}
              <div
                className="rounded-xl px-4 py-3 flex items-center gap-3"
                style={{ background: "rgba(56,189,248,.04)", border: "1px solid rgba(56,189,248,.12)" }}
              >
                {user?.imageUrl ? (
                  <img src={user.imageUrl} alt={userName} className="w-7 h-7 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white"
                    style={{ background: "linear-gradient(135deg,#4F46E5,#0EA5E9)" }}>
                    {userName.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-white truncate">{userName}</p>
                  <p className="text-xs truncate" style={{ color: "#6B7A99" }}>{userEmail}</p>
                </div>
                <span className="ml-auto text-xs shrink-0" style={{ color: "#3A4460" }}>Sending as you</span>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !subject.trim() || !message.trim()}
                className="w-full rounded-xl py-3.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg,#4F46E5,#0EA5E9)",
                  boxShadow: "0 4px 14px rgba(79,70,229,0.3)",
                }}
              >
                {isSubmitting ? "Sending…" : "Send Message"}
              </button>
            </form>

            {/* Direct email fallback */}
            <div className="mt-8 pt-6 text-center" style={{ borderTop: `1px solid ${BORDER}` }}>
              <p className="text-xs mb-2" style={{ color: "#3A4460" }}>
                Prefer to email directly?
              </p>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-sm font-medium transition-colors hover:underline"
                style={{ color: "#38BDF8" }}
              >
                {SUPPORT_EMAIL}
              </a>
            </div>
          </>
        ) : (
          /* Success state */
          <div className="flex flex-col items-center text-center pt-16">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl mb-6"
              style={{ background: "rgba(16,185,129,.12)", border: "1px solid rgba(52,211,153,.25)" }}
            >
              ✓
            </div>
            <h2 className="text-2xl font-extrabold text-white mb-3" style={{ letterSpacing: "-0.02em" }}>
              Message received
            </h2>
            <p className="text-sm mb-8 max-w-sm" style={{ color: "#6B7A99", lineHeight: "1.7" }}>
              Thanks{userName ? `, ${userName.split(" ")[0]}` : ""}. We've got your {ticketType === "bug" ? "bug report" : ticketType === "feature" ? "feature request" : "question"} and will follow up at <strong className="text-white">{userEmail}</strong>.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => { setSubmitted(false); setSubject(""); setMessage(""); }}
                className="px-5 py-2.5 rounded-xl text-sm font-medium transition-colors"
                style={{ background: SURFACE, color: "#6B7A99", border: `1px solid ${BORDER}` }}
              >
                Submit another
              </button>
              <button
                onClick={() => navigate("/dashboard")}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all"
                style={{ background: "linear-gradient(135deg,#4F46E5,#0EA5E9)" }}
              >
                Back to dashboard
              </button>
            </div>
          </div>
        )}
      </main>
      <Toaster />
    </div>
  );
}
