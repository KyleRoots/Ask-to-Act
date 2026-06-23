import { useLocation } from "wouter";

const BG = "hsl(220 50% 4%)";
const SURFACE = "hsl(222 45% 8%)";
const BORDER = "hsl(217 35% 18%)";

function LogoIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="hg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="55%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#hg)" />
      <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
      <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
      <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const features = [
  { icon: "🤖", title: "AI-powered ATS access", body: "Your team uses ChatGPT, Claude, or Gemini to query Bullhorn — no manual searching." },
  { icon: "🔒", title: "Permission-aware", body: "Every AI action respects each recruiter's existing Bullhorn permissions automatically." },
  { icon: "📊", title: "Team usage insights", body: "See who's using AI tools, how often, and where it's making the biggest impact." },
];

export default function Home() {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-[100dvh]" style={{ background: BG }}>
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[600px] rounded-full opacity-[0.12]"
          style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 right-0 w-80 h-80 rounded-full opacity-[0.08]"
          style={{ background: "radial-gradient(circle, #0EA5E9 0%, transparent 70%)" }} />
      </div>

      {/* Nav */}
      <header className="relative flex items-center justify-between px-5 sm:px-8 py-5">
        <div className="flex items-center gap-3">
          <LogoIcon size={36} />
          <span className="text-lg font-extrabold text-white tracking-tight" style={{ letterSpacing: "-0.025em" }}>
            Ask<span style={{ color: "#38BDF8" }}>To</span>Act
          </span>
        </div>
        <button
          onClick={() => navigate("/sign-in")}
          className="text-sm font-medium px-4 py-2 rounded-xl transition-colors"
          style={{ color: "#6B7A99", border: `1px solid ${BORDER}` }}
        >
          Sign in
        </button>
      </header>

      {/* Hero */}
      <main className="relative max-w-2xl mx-auto px-5 sm:px-8 pt-16 pb-10 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-8"
          style={{ background: "rgba(79,70,229,.12)", border: "1px solid rgba(79,70,229,.25)", color: "#818CF8" }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#818CF8" }} />
          Customer Portal
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight mb-6"
          style={{ letterSpacing: "-0.035em" }}>
          Your team's AI<br />
          <span style={{
            background: "linear-gradient(135deg, #818CF8 0%, #38BDF8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}>command centre</span>
        </h1>

        <p className="text-lg mb-10" style={{ color: "#6B7A99", lineHeight: "1.7" }}>
          Manage your team's access to AI tools that connect directly
          to your recruiting system — no IT setup required.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => navigate("/sign-in")}
            className="px-6 py-3.5 rounded-xl text-sm font-bold text-white transition-all active:scale-[0.97]"
            style={{
              background: "linear-gradient(135deg, #4F46E5 0%, #0EA5E9 100%)",
              boxShadow: "0 4px 20px rgba(79,70,229,0.4)",
            }}
          >
            Sign in to your portal →
          </button>
          <button
            onClick={() => navigate("/sign-up")}
            className="px-6 py-3.5 rounded-xl text-sm font-semibold transition-colors"
            style={{ background: SURFACE, color: "#94A3B8", border: `1px solid ${BORDER}` }}
          >
            Create account
          </button>
        </div>

        {/* Auth options note */}
        <p className="mt-5 text-xs" style={{ color: "#3A4460" }}>
          Sign in with Google, or use your work email
        </p>
      </main>

      {/* Feature cards */}
      <section className="relative max-w-3xl mx-auto px-5 sm:px-8 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl p-5" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div className="text-2xl mb-3">{f.icon}</div>
              <h3 className="text-sm font-semibold text-white mb-1.5">{f.title}</h3>
              <p className="text-xs leading-relaxed" style={{ color: "#4A5568" }}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="relative border-t px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-3"
        style={{ borderColor: BORDER }}>
        <span className="text-xs" style={{ color: "#3A4460" }}>
          © {new Date().getFullYear()} AskToAct · All rights reserved
        </span>
        <span className="text-xs" style={{ color: "#3A4460" }}>
          Powered by AskToAct
        </span>
      </footer>
    </div>
  );
}
