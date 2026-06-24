import { useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { portalApi } from "@/lib/api";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";

function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="dg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="55%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#dg)" />
      <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
      <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
      <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type QuickLink = { icon: string; label: string; desc: string; soon: boolean; href: string | null };

function buildQuickLinks(isAdmin: boolean): QuickLink[] {
  return [
    { icon: "👥", label: "Team Members", desc: "Manage who has AI access on your team", soon: true, href: null },
    isAdmin
      ? { icon: "📊", label: "Usage & Activity", desc: "Track how your team uses AI tools each month", soon: false, href: "/team-usage" }
      : { icon: "📊", label: "Usage & Activity", desc: "Track how your team uses AI tools each month", soon: true, href: null },
    { icon: "🔗", label: "AI Connections", desc: "Connect ChatGPT, Claude, or Gemini", soon: true, href: null },
    { icon: "🛟", label: "Support & Feedback", desc: "Report a bug, request a feature, or ask a question", soon: false, href: "/support" },
  ];
}

function ConnectorCard({ mcpUrl }: { mcpUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  function handleCopy() {
    navigator.clipboard
      .writeText(mcpUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        setFailed(true);
        setTimeout(() => setFailed(false), 2000);
      });
  }

  return (
    <div
      className="rounded-2xl p-5 mb-8"
      style={{ background: "rgba(16,185,129,.06)", border: "1px solid rgba(52,211,153,.2)" }}
    >
      <div className="flex items-start gap-4 mb-4">
        <div
          className="w-10 h-10 rounded-xl shrink-0 text-xl"
          style={{ background: "rgba(16,185,129,.15)", border: "1px solid rgba(52,211,153,.2)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          🔗
        </div>
        <div>
          <p className="text-sm font-semibold text-white mb-0.5">Your AI Connector is ready</p>
          <p className="text-xs" style={{ color: "#6B7A99", lineHeight: 1.6 }}>
            Paste this URL into ChatGPT, Claude, or Gemini under Settings → Connectors to connect your AI tool directly to Bullhorn.
          </p>
        </div>
      </div>

      <div
        className="rounded-xl flex items-center gap-3 p-3.5"
        style={{ background: "#0f1622", border: `1px solid ${BORDER}` }}
      >
        <span
          className="flex-1 text-xs font-mono break-all leading-relaxed select-all"
          style={{ color: "#94a3b8" }}
        >
          {mcpUrl}
        </span>
        <button
          onClick={handleCopy}
          className="shrink-0 px-4 py-2 rounded-lg text-xs font-semibold transition-all whitespace-nowrap"
          style={copied
            ? { background: "rgba(16,185,129,.15)", color: "#34D399", border: "1px solid rgba(52,211,153,.3)" }
            : failed
            ? { background: "rgba(248,113,113,.12)", color: "#FCA5A5", border: "1px solid rgba(248,113,113,.3)" }
            : { background: "rgba(79,70,229,.15)", color: "#818CF8", border: "1px solid rgba(129,140,248,.3)" }}
        >
          {copied ? "Copied!" : failed ? "Copy failed" : "Copy URL"}
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [, navigate] = useLocation();

  const { data: me } = useQuery({ queryKey: ["portal-me"], queryFn: portalApi.me });
  const quickLinks = buildQuickLinks(me?.role === "admin");

  const firstName = user?.firstName ?? user?.username ?? "there";

  return (
    <div className="min-h-[100dvh]" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-8 py-4"
        style={{ background: "rgba(5,13,26,.9)", backdropFilter: "blur(14px)", borderBottom: `1px solid ${BORDER}` }}
      >
        <div className="flex items-center gap-3">
          <LogoIcon size={28} />
          <span className="text-base font-extrabold text-white tracking-tight" style={{ letterSpacing: "-0.02em" }}>
            Ask<span style={{ color: "#38BDF8" }}>To</span>Act
          </span>
        </div>
        <div className="flex items-center gap-3">
          {user?.imageUrl && (
            <img
              src={user.imageUrl}
              alt={firstName}
              className="w-8 h-8 rounded-full object-cover"
            />
          )}
          <span className="hidden sm:block text-sm" style={{ color: "#6B7A99" }}>
            {user?.primaryEmailAddress?.emailAddress}
          </span>
          <button
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
            className="text-sm px-3 py-1.5 rounded-xl transition-colors"
            style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-5 sm:px-8 py-10">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mb-2"
            style={{ letterSpacing: "-0.03em" }}>
            Welcome back, {firstName} 👋
          </h1>
          <p className="text-sm" style={{ color: "#4A5568" }}>
            Your team's AI portal — manage access, view activity, and stay in control.
          </p>
        </div>

        {/* Enrollment-aware status section */}
        {me?.enrolled && me.mcpUrl ? (
          <ConnectorCard mcpUrl={me.mcpUrl} />
        ) : me && !me.enrolled ? (
          <div
            className="rounded-2xl p-5 mb-8 flex flex-col sm:flex-row items-start sm:items-center gap-4"
            style={{ background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.2)" }}
          >
            <div
              className="w-10 h-10 rounded-xl shrink-0 text-xl"
              style={{ background: "rgba(251,191,36,.1)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              ⚠️
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-white mb-0.5">Bullhorn not yet connected</p>
              <p className="text-xs" style={{ color: "#6B7A99", lineHeight: 1.6 }}>
                Your administrator will send you an enrollment link to connect your Bullhorn account. Check your email, or contact your admin.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="rounded-2xl mb-8"
            style={{ background: SURFACE, border: `1px solid ${BORDER}`, height: 80 }}
          />
        )}

        {/* Quick links grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {quickLinks.map((item) => (
            <div
              key={item.label}
              onClick={() => item.href && navigate(item.href)}
              className="rounded-2xl p-5 transition-all relative"
              style={{
                background: SURFACE,
                border: `1px solid ${BORDER}`,
                opacity: item.soon ? 0.5 : 1,
                cursor: item.soon ? "default" : "pointer",
              }}
              onMouseEnter={(e) => { if (!item.soon) (e.currentTarget as HTMLElement).style.borderColor = "rgba(79,70,229,.5)"; }}
              onMouseLeave={(e) => { if (!item.soon) (e.currentTarget as HTMLElement).style.borderColor = BORDER; }}
            >
              {item.soon && (
                <span
                  className="absolute top-4 right-4 text-xs font-medium px-2 py-0.5 rounded-md"
                  style={{ background: "rgba(148,163,184,.08)", color: "#4A5568" }}
                >
                  Coming soon
                </span>
              )}
              {!item.soon && (
                <span className="absolute top-4 right-4 text-xs" style={{ color: "#3A4460" }}>→</span>
              )}
              <div className="text-2xl mb-3">{item.icon}</div>
              <h3 className="text-sm font-semibold text-white mb-1">{item.label}</h3>
              <p className="text-xs" style={{ color: "#4A5568", lineHeight: "1.6" }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="max-w-4xl mx-auto px-5 sm:px-8 py-6 mt-4 border-t flex flex-col sm:flex-row items-center justify-between gap-3"
        style={{ borderColor: BORDER }}>
        <span className="text-xs" style={{ color: "#3A4460" }}>
          © {new Date().getFullYear()} AskToAct · All rights reserved
        </span>
        <span className="flex items-center gap-4 text-xs" style={{ color: "#3A4460" }}>
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-[#818CF8] transition-colors">Privacy</a>
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="hover:text-[#818CF8] transition-colors">Terms</a>
        </span>
      </footer>
    </div>
  );
}
