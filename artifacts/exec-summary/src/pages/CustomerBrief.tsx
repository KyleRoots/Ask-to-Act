import {
  FOUNDING_PRICING,
  LIST_PRICING,
  PILOT_FIRMS,
  ROI_10_SEAT,
  TOOL_SUMMARY,
} from "@/data/messaging";

const gradientText: React.CSSProperties = {
  background: "linear-gradient(135deg, #818CF8 0%, #38BDF8 50%, #22D3EE 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  backgroundClip: "text",
};

export default function CustomerBrief() {
  return (
    <div style={{ fontFamily: '"DM Sans", system-ui, sans-serif', background: "#050d1a", color: "#f8fafc", minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      <Ambient />
      <TopBar />
      <div style={{ position: "relative", maxWidth: "920px", margin: "0 auto", padding: "3rem 1.5rem 5rem" }}>
        <Hero />
        <ValuePills />
        <FlowStrip />
        <RoiBand />
        <Divider />
        <Section title="The whitespace we own" accent>
          <p style={body}>
            Staffing firms already pay for <strong>Bullhorn</strong> and <strong>ChatGPT</strong> — but nothing connects them.
            Recruiters copy, paste, tab-switch, and lose hours every week. There is no audit trail. No permission bridge.
            No recruiting-native intelligence layer.
          </p>
          <p style={body}>
            AskToAct is the <strong style={{ color: "#38bdf8" }}>AI action layer</strong> for staffing: model-agnostic middleware
            that lets any MCP-compatible AI read and write Bullhorn under each recruiter's own OAuth session —
            with duplicate guards, field validation, and full tool-call logging.
          </p>
        </Section>
        <Divider />
        <Section title="What ships today">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.875rem" }}>
            <FeatureCard icon="⚡" title="62+ actions" body={TOOL_SUMMARY + " on Bullhorn — live in production"} />
            <FeatureCard icon="🤖" title="Bring your AI" body="ChatGPT, Claude, Gemini — we don't sell the chatbot" />
            <FeatureCard icon="🔒" title="Their permissions" body="Every write runs under the recruiter's own Bullhorn login" />
            <FeatureCard icon="🚀" title="30-minute setup" body="Self-serve OAuth enrollment — no IT project" />
          </div>
        </Section>
        <Divider />
        <Section title="Design partners · live now">
          <p style={body}>Complimentary production pilots with our first two Bullhorn staffing firms:</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
            {PILOT_FIRMS.map((f) => (
              <PilotCard key={f.name} name={f.name} note={f.note} />
            ))}
          </div>
        </Section>
        <Divider />
        <Section title="Pricing that clears the ROI bar">
          <p style={body}>
            A 10-recruiter desk loses <strong style={{ color: "#fbbf24" }}>~${ROI_10_SEAT.productivityLost.toLocaleString()}/mo</strong> to
            manual AI↔ATS transfer. They're already spending <strong>$99–$165/user on Bullhorn</strong> plus <strong>$25–$30 on ChatGPT</strong> —
            AskToAct is the missing bridge, not another platform replacement.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.25rem", margin: "1.75rem 0" }}>
            <PriceCard
              title="Founding customer"
              price={`$${FOUNDING_PRICING.flatUpTo10Seats}/mo`}
              detail={FOUNDING_PRICING.includes}
              highlight
              badge="Best value · post-pilot"
              footnote="~40× ROI vs copy-paste tax on a 10-seat desk"
            />
            <PriceCard
              title="Standard list"
              price={`$${LIST_PRICING.platform} + $${LIST_PRICING.perActiveSeat}/seat`}
              detail="Admin, audit logs, 1 connector. Pay only for seats that use the bridge."
              footnote={`10 seats ≈ $${ROI_10_SEAT.askToActList}/mo · month-to-month`}
            />
          </div>
        </Section>
        <Divider />
        <CtaBand />
        <Footer />
      </div>
    </div>
  );
}

function Ambient() {
  return (
    <div style={{ pointerEvents: "none", position: "fixed", inset: 0, overflow: "hidden", zIndex: 0 }} aria-hidden>
      <div style={{
        position: "absolute", top: "-20%", left: "50%", transform: "translateX(-50%)",
        width: "900px", height: "700px", borderRadius: "50%",
        background: "radial-gradient(circle, rgba(79,70,229,0.22) 0%, transparent 68%)",
      }} />
      <div style={{
        position: "absolute", bottom: "5%", right: "-5%",
        width: "500px", height: "500px", borderRadius: "50%",
        background: "radial-gradient(circle, rgba(14,165,233,0.12) 0%, transparent 70%)",
      }} />
    </div>
  );
}

function TopBar() {
  return (
    <div style={{ position: "relative", zIndex: 1, borderBottom: "1px solid rgba(30,58,95,0.8)", padding: "1.25rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem", backdropFilter: "blur(12px)", background: "rgba(5,13,26,0.75)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
        <LogoMark size={32} />
        <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "1.15rem", letterSpacing: "-0.025em" }}>
          Ask<span style={{ color: "#38bdf8" }}>To</span>Act
        </span>
      </div>
      <div style={{ display: "flex", gap: "1.25rem", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", color: "#4ade80", fontWeight: 600 }}>● Production · connect.asktoact.ai</span>
        <a href="." style={{ fontSize: "0.78rem", color: "#64748b", textDecoration: "none" }}>Investor summary →</a>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div style={{ position: "relative", zIndex: 1, paddingTop: "1rem", paddingBottom: "0.5rem" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: "0.5rem",
        padding: "0.4rem 0.85rem", borderRadius: "999px", marginBottom: "1.25rem",
        background: "rgba(79,70,229,0.15)", border: "1px solid rgba(129,140,248,0.35)",
        fontSize: "0.72rem", fontWeight: 700, color: "#a5b4fc", letterSpacing: "0.14em", textTransform: "uppercase",
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#818cf8" }} />
        AI action layer for staffing
      </div>
      <h1 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "clamp(2.25rem, 6vw, 3.75rem)", lineHeight: 1.05, letterSpacing: "-0.035em", margin: "0 0 1.25rem" }}>
        We sell the rails,<br />
        <span style={gradientText}>not the chatbot.</span>
      </h1>
      <p style={{ fontSize: "clamp(1.05rem, 2.5vw, 1.25rem)", color: "#cbd5e1", lineHeight: 1.65, maxWidth: "620px", margin: 0 }}>
        Your recruiters stay in ChatGPT. Work happens in Bullhorn — under their permissions, with an audit trail on every action.
        <strong style={{ color: "#f8fafc" }}> No rip-and-replace. Live in 30 minutes.</strong>
      </p>
    </div>
  );
}

function ValuePills() {
  const items = [
    { stat: "~40×", label: "ROI at founding rate vs copy-paste tax" },
    { stat: "62+", label: "Bullhorn recruiting actions in production" },
    { stat: "$0", label: "AI cost to you — bring your own subscription" },
  ];
  return (
    <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.875rem", margin: "2rem 0 1.5rem" }}>
      {items.map((i) => (
        <div key={i.label} style={{
          background: "linear-gradient(180deg, rgba(16,37,65,0.95) 0%, rgba(13,31,54,0.85) 100%)",
          border: "1px solid #1e3a5f", borderRadius: "0.875rem", padding: "1.25rem 1rem",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        }}>
          <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "1.75rem", ...gradientText }}>{i.stat}</div>
          <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.4rem", lineHeight: 1.45 }}>{i.label}</div>
        </div>
      ))}
    </div>
  );
}

function FlowStrip() {
  const steps = [
    { label: "Their AI", sub: "ChatGPT · Claude · Gemini" },
    { label: "AskToAct", sub: "Permissions · Audit · Translation", highlight: true },
    { label: "Bullhorn", sub: "ATS system of record" },
  ];
  return (
    <div style={{ position: "relative", zIndex: 1, display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: "0.5rem", marginBottom: "1.5rem" }}>
      {steps.map((s, i) => (
        <div key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: "1 1 140px" }}>
          <div style={{
            flex: 1,
            background: s.highlight ? "linear-gradient(135deg, rgba(79,70,229,0.2) 0%, rgba(14,165,233,0.12) 100%)" : "rgba(16,37,65,0.6)",
            border: s.highlight ? "2px solid rgba(56,189,248,0.5)" : "1px solid #1e3a5f",
            borderRadius: "0.75rem", padding: "1rem", textAlign: "center",
            boxShadow: s.highlight ? "0 8px 32px rgba(79,70,229,0.2)" : "none",
          }}>
            <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "0.95rem", color: s.highlight ? "#38bdf8" : "#f8fafc" }}>{s.label}</div>
            <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginTop: "0.35rem" }}>{s.sub}</div>
          </div>
          {i < steps.length - 1 && (
            <span style={{ color: "#38bdf8", fontSize: "1.1rem", fontWeight: 700, flexShrink: 0 }} aria-hidden>→</span>
          )}
        </div>
      ))}
    </div>
  );
}

function RoiBand() {
  return (
    <div style={{
      position: "relative", zIndex: 1,
      background: "linear-gradient(135deg, rgba(251,191,36,0.08) 0%, rgba(79,70,229,0.08) 100%)",
      border: "1px solid rgba(251,191,36,0.35)", borderLeft: "4px solid #fbbf24",
      borderRadius: "0.875rem", padding: "1.25rem 1.5rem", marginBottom: "0.5rem",
    }}>
      <div style={{ fontSize: "0.68rem", color: "#fbbf24", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700, marginBottom: "0.5rem" }}>
        The cost of doing nothing
      </div>
      <p style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0", lineHeight: 1.65 }}>
        6 hours/week of copy-paste per recruiter × $60/hr = <strong style={{ color: "#fbbf24" }}>~$1,560/seat/mo wasted</strong>.
        A 10-seat desk: <strong style={{ color: "#fbbf24" }}>~$15,600/mo</strong> vs AskToAct founding rate of <strong style={{ color: "#38bdf8" }}>$399/mo</strong>.
      </p>
    </div>
  );
}

function Section({ title, children, accent }: { title: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{ position: "relative", zIndex: 1 }}>
      <h2 style={{
        fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "1.4rem",
        marginBottom: "1rem", letterSpacing: "-0.02em",
        ...(accent ? gradientText : { color: "#f8fafc" }),
      }}>{title}</h2>
      {children}
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{
      background: "rgba(16,37,65,0.7)", border: "1px solid #1e3a5f", borderRadius: "0.875rem",
      padding: "1.15rem", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
    }}>
      <div style={{ fontSize: "1.35rem", marginBottom: "0.5rem" }}>{icon}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "0.95rem", marginBottom: "0.35rem" }}>{title}</div>
      <div style={{ fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

function PilotCard({ name, note }: { name: string; note: string }) {
  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(16,37,65,0.95) 0%, rgba(5,13,26,0.9) 100%)",
      border: "1px solid rgba(74,222,128,0.45)", borderRadius: "0.875rem", padding: "1.35rem",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(74,222,128,0.08)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.65rem" }}>
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80", boxShadow: "0 0 8px rgba(74,222,128,0.6)" }} />
        <span style={{ fontSize: "0.68rem", color: "#4ade80", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>Live pilot</span>
      </div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "1.1rem" }}>{name}</div>
      <div style={{ fontSize: "0.85rem", color: "#94a3b8", marginTop: "0.35rem" }}>{note}</div>
    </div>
  );
}

function PriceCard({ title, price, detail, footnote, highlight, badge }: {
  title: string; price: string; detail: string; footnote: string; highlight?: boolean; badge?: string;
}) {
  return (
    <div style={{
      background: highlight
        ? "linear-gradient(155deg, rgba(79,70,229,0.18) 0%, rgba(14,165,233,0.1) 100%)"
        : "rgba(16,37,65,0.7)",
      border: highlight ? "2px solid rgba(56,189,248,0.55)" : "1px solid #1e3a5f",
      borderRadius: "1rem", padding: "1.5rem",
      boxShadow: highlight ? "0 12px 40px rgba(79,70,229,0.25)" : "none",
    }}>
      {badge && (
        <div style={{ fontSize: "0.65rem", color: "#38bdf8", letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, marginBottom: "0.5rem" }}>{badge}</div>
      )}
      <div style={{ fontSize: "0.72rem", color: "#94a3b8", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "0.4rem" }}>{title}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "2rem", ...(highlight ? gradientText : { color: "#f8fafc" }) }}>{price}</div>
      <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.75rem", lineHeight: 1.5 }}>{detail}</div>
      <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.75rem" }}>{footnote}</div>
    </div>
  );
}

function CtaBand() {
  return (
    <div style={{
      position: "relative", zIndex: 1, textAlign: "center",
      background: "linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%)",
      borderRadius: "1rem", padding: "2rem 1.5rem",
      boxShadow: "0 16px 48px rgba(79,70,229,0.35)",
    }}>
      <h3 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "1.35rem", margin: "0 0 0.65rem" }}>
        Ready for a pilot like Myticas or STSI?
      </h3>
      <p style={{ margin: "0 0 1.25rem", fontSize: "0.95rem", color: "rgba(255,255,255,0.9)", lineHeight: 1.55 }}>
        Complimentary evaluation → month-to-month founding pricing. No long-term contract.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", justifyContent: "center" }}>
        <a href="mailto:support@asktoact.ai" style={ctaBtn}>support@asktoact.ai</a>
        <a href="https://connect.asktoact.ai/portal/" style={{ ...ctaBtn, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.35)" }}>
          connect.asktoact.ai/portal
        </a>
      </div>
    </div>
  );
}

const ctaBtn: React.CSSProperties = {
  display: "inline-block", padding: "0.65rem 1.15rem", borderRadius: "0.65rem",
  background: "rgba(255,255,255,0.95)", color: "#312e81", fontWeight: 700, fontSize: "0.85rem",
  textDecoration: "none",
};

function LogoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cb-lg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#cb-lg)" />
      <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
      <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
      <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid rgba(30,58,95,0.7)", margin: "2.75rem 0", position: "relative", zIndex: 1 }} />;
}

function Footer() {
  return (
    <div style={{ position: "relative", zIndex: 1, borderTop: "1px solid rgba(30,58,95,0.7)", marginTop: "2.5rem", paddingTop: "1.5rem", fontSize: "0.78rem", color: "#475569", textAlign: "center" }}>
      © {new Date().getFullYear()} AskToAct · Month-to-month · No lock-in · We sell the rails, not the chatbot.
    </div>
  );
}

const body: React.CSSProperties = {
  fontSize: "1rem", color: "#cbd5e1", lineHeight: 1.75, margin: "0 0 1rem",
};
