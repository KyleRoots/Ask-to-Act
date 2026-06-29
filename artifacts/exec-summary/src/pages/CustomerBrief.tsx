import {
  FOUNDING_PRICING,
  LIST_PRICING,
  PILOT_FIRMS,
  ROI_10_SEAT,
  TOOL_SUMMARY,
} from "@/data/messaging";

export default function CustomerBrief() {
  return (
    <div style={{ fontFamily: '"DM Sans", system-ui, sans-serif', background: "#0b1a2e", color: "#f8fafc", minHeight: "100vh" }}>
      <TopBar />
      <div style={{ maxWidth: "880px", margin: "0 auto", padding: "4rem 2rem 5rem" }}>
        <Hero />
        <Divider />
        <Section title="The gap we fill">
          <p style={body}>
            Your recruiters already pay for ChatGPT or Claude. They already live in Bullhorn.
            Nothing connects the two — so they copy, paste, tab-switch, and hope they got it right.
            There is no audit trail of what the AI was asked, what it returned, or who changed what in the ATS.
          </p>
          <p style={body}>
            AskToAct is the <strong style={{ color: "#38bdf8" }}>action layer</strong> between any MCP-compatible AI
            and your systems of record. Recruiters stay in chat. Work happens in Bullhorn — under their own permissions,
            with duplicate guards and field validation before every write.
          </p>
        </Section>
        <Divider />
        <Section title="What you get today">
          <ul style={{ ...body, paddingLeft: "1.25rem", margin: 0 }}>
            <li style={{ marginBottom: "0.75rem" }}><strong>{TOOL_SUMMARY}</strong> on Bullhorn — search, read, submit, note, status changes, jobs, companies, contacts, tasks, placements, résumé upload, and more</li>
            <li style={{ marginBottom: "0.75rem" }}>Works with <strong>ChatGPT, Claude, Gemini</strong> — bring your own AI subscription</li>
            <li style={{ marginBottom: "0.75rem" }}>Each recruiter connects <strong>their own Bullhorn account</strong> via OAuth — no shared admin password</li>
            <li style={{ marginBottom: "0.75rem" }}>Self-serve onboarding: admin provisions seats → recruiters enroll → paste a URL into ChatGPT</li>
            <li><strong>Live production</strong> at connect.asktoact.ai — not a prototype</li>
          </ul>
        </Section>
        <Divider />
        <Section title="Who is piloting now">
          <p style={body}>
            We are running <strong>complimentary pilots</strong> with our first two staffing firms on Bullhorn:
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
            {PILOT_FIRMS.map((f) => (
              <div key={f.name} style={{ background: "#102541", border: "1px solid #4ade80", borderRadius: "0.75rem", padding: "1.25rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div style={{ width: "0.45rem", height: "0.45rem", borderRadius: "50%", background: "#4ade80" }} />
                  <span style={{ fontSize: "0.7rem", color: "#4ade80", letterSpacing: "0.12em", textTransform: "uppercase" }}>Free pilot · Live</span>
                </div>
                <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "1.05rem" }}>{f.name}</div>
                <div style={{ fontSize: "0.85rem", color: "#94a3b8", marginTop: "0.35rem" }}>{f.note}</div>
              </div>
            ))}
          </div>
        </Section>
        <Divider />
        <Section title="Pricing — built to be a no-brainer">
          <p style={body}>
            A 10-recruiter desk loses roughly <strong style={{ color: "#fbbf24" }}>${ROI_10_SEAT.productivityLost.toLocaleString()}/month</strong> to
            copy-paste between AI and Bullhorn ({ROI_10_SEAT.hoursPerWeek}h/week × ${ROI_10_SEAT.burdenedHourly}/hr burdened).
            Most firms already spend <strong>$99–$165/user/month on Bullhorn</strong> plus <strong>$25–$30/user on ChatGPT</strong> — before any bridge exists.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem", margin: "1.5rem 0" }}>
            <PriceCard
              title="Founding customer (post-pilot)"
              price={`$${FOUNDING_PRICING.flatUpTo10Seats}/mo`}
              detail={FOUNDING_PRICING.includes}
              highlight
              footnote="Recommended for first commercial firms converting from pilot"
            />
            <PriceCard
              title="Standard list pricing"
              price={`$${LIST_PRICING.platform} + $${LIST_PRICING.perActiveSeat}/seat`}
              detail="Platform includes admin, audit logs, 1 connector. Billed only for seats that use the bridge that month."
              footnote={`10 active seats ≈ $${ROI_10_SEAT.askToActList}/mo · month-to-month`}
            />
          </div>
          <p style={{ ...body, fontSize: "0.9rem", color: "#94a3b8" }}>
            Additional connectors (Salesforce, Workday, etc.) · ${LIST_PRICING.additionalConnector}/mo each when available.
            Optional white-glove setup · ${LIST_PRICING.whiteGloveSetup.toLocaleString()} — most firms self-serve for free.
          </p>
        </Section>
        <Divider />
        <Section title="Start a conversation">
          <p style={body}>
            Interested in a pilot like Myticas or STSI? We offer a <strong>complimentary evaluation period</strong>,
            then month-to-month founding pricing — no long-term contract required.
          </p>
          <p style={{ ...body, marginBottom: 0 }}>
            <a href="mailto:support@asktoact.ai" style={{ color: "#38bdf8", fontWeight: 600 }}>support@asktoact.ai</a>
            {" · "}
            <a href="https://connect.asktoact.ai/portal/" style={{ color: "#38bdf8", fontWeight: 600 }}>connect.asktoact.ai/portal</a>
          </p>
        </Section>
        <Footer />
      </div>
    </div>
  );
}

function TopBar() {
  return (
    <div style={{ borderBottom: "1px solid #1e3a5f", padding: "1.25rem 2rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "1rem" }}>
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "1.1rem" }}>
        Ask<span style={{ color: "#38bdf8" }}>To</span>Act
      </span>
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.8rem", color: "#4ade80" }}>● Live · connect.asktoact.ai</span>
        <a href="." style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Internal summary →</a>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "#38bdf8", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: "1rem" }}>
        Customer overview
      </div>
      <h1 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "clamp(2rem, 5vw, 3rem)", lineHeight: 1.1, letterSpacing: "-0.03em", margin: "0 0 1.25rem" }}>
        We sell the rails,<br /><span style={{ color: "#38bdf8" }}>not the chatbot.</span>
      </h1>
      <p style={{ fontSize: "1.1rem", color: "#cbd5e1", lineHeight: 1.65, maxWidth: "640px", margin: 0 }}>
        AskToAct connects the AI your team already uses to Bullhorn — with permissions, validation, and an audit trail on every action.
        Type in ChatGPT. The right thing happens in your ATS.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: "1.35rem", marginBottom: "1rem" }}>{title}</h2>
      {children}
    </div>
  );
}

function PriceCard({ title, price, detail, footnote, highlight }: { title: string; price: string; detail: string; footnote: string; highlight?: boolean }) {
  return (
    <div style={{
      background: highlight ? "rgba(56,189,248,0.06)" : "#102541",
      border: `1px solid ${highlight ? "#38bdf8" : "#1e3a5f"}`,
      borderRadius: "0.75rem",
      padding: "1.5rem",
    }}>
      <div style={{ fontSize: "0.7rem", color: "#94a3b8", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "0.5rem" }}>{title}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: "1.75rem", color: highlight ? "#38bdf8" : "#f8fafc" }}>{price}</div>
      <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.75rem", lineHeight: 1.5 }}>{detail}</div>
      <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.75rem" }}>{footnote}</div>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: "1px solid #1e3a5f", margin: "2.5rem 0" }} />;
}

function Footer() {
  return (
    <div style={{ borderTop: "1px solid #1e3a5f", marginTop: "3rem", paddingTop: "1.5rem", fontSize: "0.8rem", color: "#475569" }}>
      © {new Date().getFullYear()} AskToAct · Month-to-month · No lock-in
    </div>
  );
}

const body: React.CSSProperties = {
  fontSize: "1rem",
  color: "#cbd5e1",
  lineHeight: 1.75,
  margin: "0 0 1rem",
};
