export default function ExecSummary() {
  return (
    <div style={{ fontFamily: '"DM Sans", system-ui, sans-serif', background: '#0b1a2e', color: '#f8fafc', minHeight: '100vh' }}>

      {/* Top bar */}
      <div style={{ borderBottom: '1px solid #1e3a5f', padding: '1.5rem 4rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: '0.6rem', height: '0.6rem', borderRadius: '50%', background: '#38bdf8' }} />
          <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1.25rem', letterSpacing: '-0.01em' }}>Relay</span>
        </div>
        <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
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
        <p style={{ fontSize: '1.2rem', color: '#cbd5e1', lineHeight: 1.6, maxWidth: '680px', margin: 0 }}>
          Relay is the AI action layer for the recruiting and staffing stack — a model-agnostic middleware
          that lets any AI assistant read and write to Bullhorn, Salesforce, LinkedIn, and the rest, with
          role-based permissions and a full audit trail baked in from day one.
        </p>
      </div>

      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '0 4rem 6rem' }}>

        {/* Key stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '4rem' }}>
          <Stat number="5–8h" label="Recruiter time lost per week to manual copy-paste between AI and ATS" />
          <Stat number="$0" label="Audit trail at competing firms — no system captures what the AI was asked to do" accent="#fbbf24" />
          <Stat number="2026" label="First mover on the open protocol now adopted by ChatGPT, Claude, and Gemini" />
        </div>

        {/* Section: The Problem */}
        <Section title="The Problem" index="01">
          <p style={bodyStyle}>
            Recruiting and staffing teams are adopting AI tools — but every tool they add creates a new friction point.
            The AI lives on one side of the screen; the ATS, CRM, and HRIS live on the other. The recruiter bridges
            the gap manually: read output, switch tab, copy data, find the right record, paste, save, repeat.
          </p>
          <p style={bodyStyle}>
            This isn't a productivity issue. It's a structural one. No current tool closes the loop between an AI's
            response and a system of record. And as AI usage scales, the copy-paste tax scales with it.
          </p>
          <p style={bodyStyle}>
            There's a second problem: governance. When a recruiter uses ChatGPT to draft an outreach sequence and
            manually inputs those candidates into Bullhorn, there's no record of what prompt produced what data,
            what the AI recommended, or who changed what. Enterprise buyers increasingly ask for this — and have no answer.
          </p>
        </Section>

        <Divider />

        {/* Section: The Solution */}
        <Section title="What Relay Does" index="02">
          <p style={bodyStyle}>
            Relay is a remote MCP (Model Context Protocol) server — a standardized interface that connects any
            MCP-compatible AI to any system we've built a connector for. The AI issues a natural-language intent;
            Relay translates it into a validated, permissioned API call; the system of record does the work.
          </p>
          <p style={bodyStyle}>
            From the recruiter's perspective: they type in ChatGPT. The right thing happens in Bullhorn.
            They never leave the AI interface.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', margin: '2rem 0' }}>
            <FlowBox label="AI" sub="ChatGPT, Claude, Gemini — whatever the customer uses" highlight={false} />
            <FlowBox label="Relay" sub="Permissions · Translation · Audit" highlight={true} />
            <FlowBox label="Systems" sub="Bullhorn, Salesforce, LinkedIn, HRIS" highlight={false} />
          </div>

          <p style={bodyStyle}>
            Relay is model-agnostic by design. It does not sell an AI — it assumes the customer already has one.
            This is a durable architectural bet: AI providers will continue to commoditize while the value of
            clean, permissioned access to complex enterprise systems compounds.
          </p>
          <p style={bodyStyle}>
            The first connector targets Bullhorn ATS and covers the complete recruiter workflow: candidate search,
            profile reads, contact lookup, job management, submission tracking, and placement recording. The
            connector was built on a working implementation, already tested against a live Bullhorn environment
            (Myticas Consulting).
          </p>
        </Section>

        <Divider />

        {/* Section: Why We Win */}
        <Section title="Why Relay Wins" index="03">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', margin: '1rem 0 2rem' }}>
            <MoatCard number="01" title="Model-agnostic" body="Works with whichever AI the customer already pays for. No vendor dependency. As models commoditize, the bridge becomes more valuable, not less." />
            <MoatCard number="02" title="Domain-deep" body="Built specifically for recruiting and staffing workflows — not generic CRUD wrappers. The vocabulary, entity model, and permission structures map to how the industry actually operates." />
            <MoatCard number="03" title="Governance from day one" body="Role-based access control and immutable audit logs are core architecture, not bolt-ons. This is the feature enterprise procurement teams demand first — and almost no AI tooling offers it." />
            <MoatCard number="04" title="First-mover on the standard" body="MCP is the open protocol that ChatGPT, Claude, Anthropic, and Google have all adopted. Building now means owning the standard in this vertical before the horizontal players notice it." />
          </div>
          <p style={bodyStyle}>
            The horizontal players (Zapier, Unified.to, Merge.dev) solve generic connectivity. They are
            strategically valuable as backbone infrastructure for building connectors — Relay will compose
            on top of these where they cover a system well, building custom connectors only where domain depth
            demands it. This keeps connector cost low while preserving the differentiation layer that horizontal
            players cannot replicate: deep recruiting domain logic and governance rails.
          </p>
        </Section>

        <Divider />

        {/* Section: Business Model */}
        <Section title="How It Makes Money" index="04">
          <p style={bodyStyle}>
            Relay runs on recurring SaaS revenue across three stacked streams, plus a one-time onboarding fee
            per customer firm. All pricing is illustrative at this stage and will be tested against early
            customer conversations.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', margin: '2rem 0' }}>
            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Recurring Streams</div>
              <RevenueRow label="Platform fee" desc="Base subscription — access to the Relay layer" />
              <RevenueRow label="Per-system fee" desc="Each connected system (Bullhorn, Salesforce, etc.)" />
              <RevenueRow label="Per-active-seat" desc="Billed only when the seat actively uses the bridge" />
              <div style={{ borderTop: '1px solid #1e3a5f', marginTop: '1.25rem', paddingTop: '1.25rem' }}>
                <RevenueRow label="Onboarding · one-time" desc="$2,500–$5,000 per firm. Compliance tier available." gold />
              </div>
            </div>

            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Worked Examples · Monthly ARR Run Rate</div>
              <PricingRow seats="10 seats" range="$1,500–$2,000 / mo" />
              <PricingRow seats="50 seats" range="$4,500–$6,000 / mo" />
              <PricingRow seats="100 seats" range="$8,000–$12,000 / mo" />
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '1.5rem', lineHeight: 1.5 }}>
                Margin stays high because Relay does not pay for the AI — the customer does.
                Infrastructure cost per seat is low and falls as volume grows.
              </p>
            </div>
          </div>

          <p style={bodyStyle}>
            The model benefits from a natural expansion motion: a firm signs on with one system connector,
            adds a second (e.g. Salesforce CRM alongside Bullhorn), and seat count grows as the tool proves
            its value to the desk. Each expansion is incremental revenue with near-zero incremental cost.
          </p>
        </Section>

        <Divider />

        {/* Section: Market */}
        <Section title="Market Opportunity" index="05">
          <p style={bodyStyle}>
            The global staffing and recruiting market is a multi-hundred-billion dollar industry running on
            legacy systems. Bullhorn alone serves over 10,000 staffing and recruiting firms worldwide.
            The AI adoption curve in this sector is early but accelerating — every desk that adds a ChatGPT
            subscription is a potential Relay customer.
          </p>
          <p style={bodyStyle}>
            Near-term addressable market: the mid-market staffing firm (20–500 desks) that has adopted AI
            tools but lacks the technical resources to build native integrations. These firms spend heavily
            on recruitment technology and have clear line-of-sight to ROI from reducing manual transfer work.
          </p>
          <p style={bodyStyle}>
            Longer-term, Relay is positioned as infrastructure for the recruiting stack — the layer every
            AI tool in the vertical routes through. As the standard matures, the value shifts from "nice
            connector" to "required middleware," compounding the switching cost for customers and expanding
            the wedge for additional connected systems.
          </p>
        </Section>

        <Divider />

        {/* Section: Proof Point */}
        <Section title="Proof of Concept" index="06">
          <div style={{ background: '#102541', border: '1px solid #38bdf8', borderRadius: '0.75rem', padding: '2rem', marginBottom: '1.5rem' }}>
            <div style={{ fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1rem' }}>Customer Zero · Myticas Consulting</div>
            <p style={{ fontSize: '1rem', color: '#cbd5e1', lineHeight: 1.7, margin: 0 }}>
              The Bullhorn connector was built and tested against a live Bullhorn environment at Myticas Consulting,
              a staffing firm currently using Bullhorn ATS. The implementation is working: it supports natural-language
              candidate search, profile lookup, job management, submission tracking, and placement recording — the
              complete core workflow of a recruiting desk. This is not a prototype against a sandbox. It is a
              functioning tool on a real ATS.
            </p>
          </div>
          <p style={bodyStyle}>
            The path to revenue is a paid pilot with Myticas or a comparable firm, converting the current
            implementation from a proof of concept into a supported commercial deployment. That pilot validates
            pricing, surfaces the additional connector requirements a second customer would need, and produces
            the case study material that de-risks conversations with the next ten firms.
          </p>
        </Section>

        <Divider />

        {/* Section: What We Need */}
        <Section title="What We Need" index="07">
          <p style={bodyStyle}>
            Three decisions from the team to move this from proof of concept to commercial product:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', margin: '1.75rem 0' }}>
            <AskCard number="1" title="Resource alignment" body="Confirm the budget envelope and engineering hours required to take the current implementation to a paid commercial deployment with the first customer firm." />
            <AskCard number="2" title="Timeline approval" body="Sign off on the roadmap from Bullhorn connector to multi-system support and the first three commercial customers." />
            <AskCard number="3" title="Go / No-go" body="A clear green light to begin commercializing — or the specific objections the team needs addressed before that decision can be made." />
          </div>
          <p style={bodyStyle}>
            Relay does not need a finished product to start selling. The working Bullhorn connector is a
            fundable, demonstrable proof. The next milestone is one paying customer and one second-connector
            in flight. We are asking for alignment on that scope.
          </p>
        </Section>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #1e3a5f', marginTop: '4rem', paddingTop: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#38bdf8' }} />
            <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1rem' }}>Relay</span>
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
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '1rem' }}>{seats}</span>
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1rem', color: '#38bdf8' }}>{range}</span>
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
