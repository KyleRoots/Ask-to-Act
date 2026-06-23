export default function ExecSummary() {
  return (
    <div style={{ fontFamily: '"DM Sans", system-ui, sans-serif', background: '#0b1a2e', color: '#f8fafc', minHeight: '100vh' }}>

      {/* Top bar */}
      <div style={{ borderBottom: '1px solid #1e3a5f', padding: '1.5rem 4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id="ata-es" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#4338CA" />
                <stop offset="55%" stopColor="#4F46E5" />
                <stop offset="100%" stopColor="#0EA5E9" />
              </linearGradient>
              <radialGradient id="ata-es-glow" cx="40%" cy="30%" r="60%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
            </defs>
            <rect width="48" height="48" rx="13" fill="url(#ata-es)" />
            <rect width="48" height="48" rx="13" fill="url(#ata-es-glow)" />
            <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
            <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
            <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="20" cy="43" r="1.4" fill="white" fillOpacity="0.55" />
            <circle cx="24" cy="45" r="1.1" fill="white" fillOpacity="0.35" />
            <circle cx="28" cy="43" r="0.8" fill="white" fillOpacity="0.2" />
          </svg>
          <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: '1.2rem', letterSpacing: '-0.025em', lineHeight: 1 }}>
            Ask<span style={{ color: '#38BDF8' }}>To</span>Act
          </span>
        </div>
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '0.45rem', height: '0.45rem', borderRadius: '50%', background: '#4ade80' }} />
            <span style={{ fontSize: '0.8rem', color: '#4ade80', letterSpacing: '0.08em' }}>Live · connect.asktoact.ai</span>
          </div>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Internal · Confidential</span>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Executive Summary · 2026</span>
        </div>
      </div>

      {/* Hero */}
      <div style={{ padding: '5rem 4rem 3.5rem', maxWidth: '960px', margin: '0 auto' }}>
        <div style={{ fontSize: '0.75rem', color: '#38bdf8', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Product Overview</div>
        <h1 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: 'clamp(2.5rem, 5vw, 4rem)', lineHeight: 1, letterSpacing: '-0.03em', margin: '0 0 1.5rem' }}>
          We sell the rails,<br /><span style={{ color: '#38bdf8' }}>not the chatbot.</span>
        </h1>
        <p style={{ fontSize: '1.2rem', color: '#cbd5e1', lineHeight: 1.6, maxWidth: '680px', margin: '0 0 2rem' }}>
          AskToAct is the AI action layer for the recruiting and staffing stack: a model-agnostic middleware
          that lets any AI assistant read and write to Bullhorn, Salesforce, Workday, and the rest, with
          role-based permissions and a full audit trail baked in from day one.
        </p>

        {/* Elevator pitch callout */}
        <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.25)', borderLeft: '3px solid #38bdf8', borderRadius: '0.75rem', padding: '1.5rem 1.75rem', maxWidth: '680px' }}>
          <div style={{ fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>The 30-Second Version</div>
          <p style={{ fontSize: '1rem', color: '#e2e8f0', lineHeight: 1.7, margin: 0, fontStyle: 'italic' }}>
            "Your recruiters already pay for ChatGPT or Claude. AskToAct makes it actually do something inside their ATS — with their own Bullhorn permissions enforced server-side, duplicate-proof writes, and a full audit trail on every action. They don't replace the AI. They don't replace the ATS. We close the loop between them. We sell the rails, not the chatbot."
          </p>
        </div>
      </div>

      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '0 4rem 6rem' }}>

        {/* Key stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '4rem' }}>
          <Stat number="5–8h" label="Recruiter time lost per week to manual copy-paste between AI and ATS" />
          <Stat number="$0" label="Audit trail at competing firms — no system captures what the AI was asked to do" accent="#fbbf24" />
          <Stat number="37" label="Specific recruiting actions a recruiter can take from ChatGPT or Claude — search, read, submit, note, update — all live in production today" accent="#4ade80" />
        </div>

        {/* Section: The Problem */}
        <Section title="The Problem" index="01">
          <p style={bodyStyle}>
            Recruiting and staffing teams are adopting AI tools fast, but every tool they add creates a new friction point.
            The AI lives on one side of the screen; the ATS, CRM, and HRIS live on the other. The recruiter bridges
            the gap manually: read output, switch tab, copy data, find the right record, paste, save, repeat.
          </p>
          <p style={bodyStyle}>
            This isn't a productivity issue. It's a structural one. No current tool closes the loop between an AI's
            response and a system of record. As AI usage scales across a desk, the copy-paste tax scales with it.
          </p>
          <p style={bodyStyle}>
            There's a second problem: governance. When a recruiter uses ChatGPT to draft an outreach sequence and
            manually inputs candidates into Bullhorn, there is no record of what prompt produced what data,
            what the AI recommended, or who changed what. Enterprise buyers ask for this. No AI tooling today offers it.
          </p>
        </Section>

        <Divider />

        {/* Section: The Solution */}
        <Section title="What AskToAct Does" index="02">
          <p style={bodyStyle}>
            AskToAct is a remote MCP (Model Context Protocol) server: a standardized interface that connects any
            MCP-compatible AI to any system we've built a connector for. The AI issues a natural-language intent;
            AskToAct translates it into a validated, permissioned API call; the system of record does the work.
          </p>
          <p style={bodyStyle}>
            From the recruiter's perspective: they type in ChatGPT. The right thing happens in Bullhorn.
            They never leave the AI interface.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', margin: '2rem 0' }}>
            <FlowBox label="AI" sub="ChatGPT, Claude, Gemini (whatever the customer uses)" highlight={false} />
            <FlowBox label="AskToAct" sub="Permissions · Translation · Audit" highlight={true} />
            <FlowBox label="Systems" sub="Bullhorn, Salesforce, Workday, ADP" highlight={false} />
          </div>

          <p style={bodyStyle}>
            AskToAct is model-agnostic by design. It does not sell an AI; it assumes the customer already has one.
            The first connector covers 37 tools across the complete Bullhorn workflow: candidate search and profile reads,
            contact lookup, job management, submission tracking, note writing, and placement recording. Every write tool
            runs under the recruiter's own Bullhorn OAuth session — not a shared service account — so Bullhorn's own
            permission gates enforce what each user can and cannot do. The implementation is live and in production.
          </p>
        </Section>

        <Divider />

        {/* Section: Why We Win */}
        <Section title="Why AskToAct Wins" index="03">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', margin: '1rem 0 2rem' }}>
            <MoatCard number="01" title="Model-agnostic" body="Works with whichever AI the customer already pays for. No vendor dependency. As models commoditize, the connection layer becomes more valuable, not less." />
            <MoatCard number="02" title="Per-user permission enforcement" body="Every write runs under the recruiter's own Bullhorn session — not a shared admin account. IT can approve deployment without granting the AI elevated access. This is the question enterprise security teams ask first." />
            <MoatCard number="03" title="Data integrity layer" body="Duplicate-proof submission guard, locked headline metrics validated on every call, server-side field validation before every write. Generic wrappers write whatever the AI says. We don't." />
            <MoatCard number="04" title="First-mover on the standard" body="MCP is the open protocol adopted by ChatGPT, Claude, and Gemini. Building the recruiting-domain vocabulary and workflow patterns now means we own the vertical before horizontal players notice it." />
          </div>
          <p style={bodyStyle}>
            The moat is not the integration. The moat is what sits between the AI and the write: permission inheritance,
            data integrity enforcement, and audit trail capture — built into the architecture from day one, not bolted on later.
            A generic API wrapper takes two days to build. This layer took months of recruiting-domain work, and it compounds
            with every customer added.
          </p>
          <p style={bodyStyle}>
            Horizontal players (Zapier, Unified.to, Merge.dev) solve generic connectivity and are strategically useful as
            backbone for commodity connectors. AskToAct composes on top of these where they cover a system well, and builds
            custom connectors only where domain depth demands it — keeping infrastructure cost low while preserving
            the differentiation layer horizontal players cannot replicate.
          </p>
        </Section>

        <Divider />

        {/* Section: Business Model */}
        <Section title="How It Makes Money" index="04">
          <p style={bodyStyle}>
            AskToAct runs on three stacked recurring streams plus a one-time onboarding fee. The unit economics are strong:
            infrastructure cost per seat is low and falls with volume; the AI cost is borne entirely by the customer.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', margin: '2rem 0' }}>
            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Pricing Structure</div>
              <RevenueRow label="Platform · $499 / mo" desc="Base access, admin dashboard, audit logs, 1 ATS connector included" />
              <RevenueRow label="Per-active-seat · $29 / mo" desc="Only billed when a seat makes at least one AI call that month" />
              <RevenueRow label="Additional connectors · $299 / mo" desc="Each system beyond the first (Salesforce, Workday, Greenhouse…)" />
              <div style={{ borderTop: '1px solid #1e3a5f', marginTop: '1.25rem', paddingTop: '1.25rem' }}>
                <RevenueRow label="Onboarding · $3,500 one-time" desc="Setup, training, OAuth registration. Waived on annual plans." gold />
              </div>
            </div>

            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Worked Examples · Monthly Recurring</div>
              <PricingRow seats="10 active seats · 1 connector" range="~$789 / mo" />
              <PricingRow seats="25 active seats · 1 connector" range="~$1,200 / mo" />
              <PricingRow seats="50 active seats · 2 connectors" range="~$2,200 / mo" />
              <PricingRow seats="100 active seats · 3 connectors" range="~$4,000 / mo" />
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '1.5rem', lineHeight: 1.5 }}>
                Natural expansion motion: firms add seats as AI proves its value to the desk,
                then add connectors as the second system demands it. Each step is incremental revenue at near-zero incremental cost.
              </p>
            </div>
          </div>

          <div style={{ background: '#0d1f36', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.5rem', marginTop: '1rem' }}>
            <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1rem' }}>Access Management · How Onboarding Works</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
              <OnboardStep num="1" label="Firm signs up" desc="Admin account provisioned via subscription gate" />
              <OnboardStep num="2" label="Seats provisioned" desc="Admin creates recruiter accounts from their dashboard" />
              <OnboardStep num="3" label="Self-serve enrollment" desc="Each recruiter OAuth-connects their own Bullhorn account" />
              <OnboardStep num="4" label="Paste and go" desc="Recruiter pastes their personal MCP URL into ChatGPT or Claude" />
            </div>
          </div>
        </Section>

        <Divider />

        {/* Section: Market */}
        <Section title="Market Opportunity" index="05">
          <p style={bodyStyle}>
            The global staffing and recruiting market is a multi-hundred-billion dollar industry running on
            legacy systems. Bullhorn alone serves over 10,000 staffing and recruiting firms worldwide.
            Every desk that adds a ChatGPT or Claude subscription is a potential AskToAct customer — and AI
            adoption in this sector is early but accelerating.
          </p>
          <p style={bodyStyle}>
            Near-term addressable market: the mid-market staffing firm (20–500 desks) that has adopted AI
            tools but lacks the technical resources to build native integrations. These firms spend heavily
            on recruitment technology and have clear line-of-sight to ROI from eliminating manual transfer work.
          </p>
          <p style={bodyStyle}>
            Longer-term, AskToAct is positioned as required middleware for the recruiting stack — the layer every
            AI tool in the vertical routes through. As the standard matures, switching cost compounds and the wedge
            for additional connected systems expands automatically.
          </p>
        </Section>

        <Divider />

        {/* Section: Live Deployment */}
        <Section title="Customer Zero · Live in Production" index="06">
          <div style={{ background: '#102541', border: '1px solid #4ade80', borderRadius: '0.75rem', padding: '2rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
              <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#4ade80' }} />
              <div style={{ fontSize: '0.7rem', color: '#4ade80', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Live · Myticas Consulting · connect.asktoact.ai</div>
            </div>
            <p style={{ fontSize: '1rem', color: '#cbd5e1', lineHeight: 1.7, margin: 0 }}>
              The Bullhorn connector is deployed and running in production. Myticas Consulting, a staffing firm
              on Bullhorn ATS, is Customer Zero: 37 MCP tools live, per-user OAuth enforced, full audit logging active.
              Recruiters can search candidates, read profiles, create submissions, add notes, and update statuses
              directly from ChatGPT or Claude — with no elevated permissions and no manual copy-paste.
              This is not a prototype. It is a functioning product on a real ATS with a real custom domain.
            </p>
          </div>
          <p style={bodyStyle}>
            The path to revenue is converting this deployment from an internal proof of concept to a paid commercial
            pilot — either with Myticas or a comparable firm. That pilot validates pricing, surfaces the field-mapping
            requirements a second customer would need, and produces the case study that de-risks conversations with
            the next ten firms.
          </p>
        </Section>

        <Divider />

        {/* Section: What We Need */}
        <Section title="Next Steps" index="07">
          <p style={bodyStyle}>
            The implementation is live and the platform is production-ready. The billing layer, customer portal,
            and self-serve onboarding flow are all deployed. The next milestone is converting the proof of concept
            to paid revenue and expanding the platform. Three decisions move this forward:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', margin: '1.75rem 0' }}>
            <AskCard number="1" title="First paying customer" body="Convert the Myticas deployment to a paid pilot or sign a comparable staffing firm. Validates pricing, surfaces field-mapping requirements for customer two, and produces the first case study." />
            <AskCard number="2" title="Production go-live" body="Deploy to connect.asktoact.ai, activate live-mode Stripe billing, and complete Clerk authentication setup for the production domain. The platform is ready — this is a configuration step, not a build step." />
            <AskCard number="3" title="Second connector decision" body="Prioritize the next ATS or CRM connector (Salesforce, Greenhouse, Lever) based on the first three commercial customer conversations." />
          </div>
          <p style={bodyStyle}>
            AskToAct does not need more product to start selling. The connector is live, the billing layer is built,
            and the customer portal is running. The next action is a sales call, not a sprint.
          </p>
        </Section>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #1e3a5f', marginTop: '4rem', paddingTop: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#38bdf8' }} />
            <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1rem' }}>AskToAct</span>
          </div>
          <span style={{ fontSize: '0.8rem', color: '#475569' }}>Internal · Confidential · 2026</span>
        </div>

      </div>
    </div>
  );
}

const bodyStyle: React.CSSProperties = {
  fontSize: '1rem',
  color: '#cbd5e1',
  lineHeight: 1.75,
  margin: '0 0 1rem',
};

function Section({ title, index, children }: { title: string; index: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '3rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem', marginBottom: '1.5rem' }}>
        <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.2em', textTransform: 'uppercase' }}>{index}</span>
        <h2 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1.6rem', letterSpacing: '-0.02em', margin: 0 }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid #1e3a5f', margin: '3rem 0' }} />;
}

function Stat({ number, label, accent }: { number: string; label: string; accent?: string }) {
  return (
    <div style={{ borderTop: `2px solid ${accent ?? '#38bdf8'}`, paddingTop: '1.25rem' }}>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: '2.5rem', lineHeight: 1, color: accent ?? '#38bdf8', letterSpacing: '-0.03em' }}>{number}</div>
      <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.5 }}>{label}</div>
    </div>
  );
}

function FlowBox({ label, sub, highlight }: { label: string; sub: string; highlight: boolean }) {
  return (
    <div style={{
      background: highlight ? 'rgba(56,189,248,0.08)' : '#102541',
      border: `${highlight ? '2px' : '1px'} solid ${highlight ? '#38bdf8' : '#1e3a5f'}`,
      borderRadius: '0.75rem',
      padding: '1.25rem',
      textAlign: 'center',
    }}>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1.1rem', color: highlight ? '#38bdf8' : '#f8fafc', marginBottom: '0.5rem' }}>{label}</div>
      <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

function MoatCard({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.5rem' }}>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: '1.8rem', color: '#38bdf8', lineHeight: 1, marginBottom: '0.75rem' }}>{number}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '1rem', marginBottom: '0.6rem' }}>{title}</div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

function RevenueRow({ label, desc, gold }: { label: string; desc: string; gold?: boolean }) {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.9rem', color: gold ? '#fbbf24' : '#38bdf8', marginBottom: '0.2rem' }}>{label}</div>
      <div style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.4 }}>{desc}</div>
    </div>
  );
}

function PricingRow({ seats, range }: { seats: string; range: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid #1e3a5f', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.9rem', color: '#cbd5e1' }}>{seats}</span>
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1rem', color: '#38bdf8' }}>{range}</span>
    </div>
  );
}

function OnboardStep({ num, label, desc }: { num: string; label: string; desc: string }) {
  return (
    <div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: '1.4rem', color: '#38bdf8', marginBottom: '0.4rem' }}>{num}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '0.8rem', color: '#64748b', lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}

function AskCard({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div style={{ borderTop: `2px solid #38bdf8`, paddingTop: '1.25rem' }}>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: '1.5rem', color: '#38bdf8', marginBottom: '0.5rem' }}>{number}</div>
      <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '1rem', marginBottom: '0.6rem' }}>{title}</div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}
