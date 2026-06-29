import {
  FOUNDING_PRICING,
  LIST_PRICING,
  PILOT_FIRMS,
  ROI_10_SEAT,
  TOOL_SUMMARY,
} from "@/data/messaging";

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
          <a href="customer" style={{ fontSize: '0.8rem', color: '#64748b', textDecoration: 'none' }}>Customer brief →</a>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Executive Summary · 2026</span>
        </div>
      </div>

      {/* Hero */}
      <div style={{ padding: '5rem 4rem 3.5rem', maxWidth: '960px', margin: '0 auto' }}>
        <div style={{ fontSize: '0.75rem', color: '#38bdf8', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Product Overview</div>
        <h1 style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 800, fontSize: 'clamp(2.5rem, 5vw, 4rem)', lineHeight: 1, letterSpacing: '-0.03em', margin: '0 0 1.5rem' }}>
          We sell the rails,<br />
          <span style={{
            background: 'linear-gradient(135deg, #818CF8 0%, #38BDF8 50%, #22D3EE 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>not the chatbot.</span>
        </h1>
        <p style={{ fontSize: '1.2rem', color: '#cbd5e1', lineHeight: 1.6, maxWidth: '680px', margin: '0 0 1.5rem' }}>
          AskToAct is the AI action layer for the recruiting and staffing stack: a model-agnostic middleware
          that lets any AI assistant read and write to Bullhorn, Salesforce, Workday, and the rest, with
          role-based permissions and a full audit trail baked in from day one.
        </p>

        {/* ROI hook */}
        <div style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.3)', borderLeft: '3px solid #fbbf24', borderRadius: '0.75rem', padding: '1.25rem 1.75rem', maxWidth: '680px', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: '0.7rem', color: '#fbbf24', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>The Cost of Not Subscribing</div>
          <p style={{ fontSize: '0.95rem', color: '#e2e8f0', lineHeight: 1.7, margin: 0 }}>
            copy-paste between AI and Bullhorn ({ROI_10_SEAT.hoursPerWeek}h/wk × ${ROI_10_SEAT.burdenedHourly}/hr burdened). Across a 10-seat desk that's <strong style={{ color: '#fbbf24' }}>~${ROI_10_SEAT.productivityLost.toLocaleString()}/month</strong> — and AskToAct at list pricing for that desk is <strong style={{ color: '#38bdf8' }}>${ROI_10_SEAT.askToActList}/month</strong> (founding rate: <strong style={{ color: '#38bdf8' }}>${ROI_10_SEAT.askToActFounding}/month</strong>). That's a <strong style={{ color: '#38bdf8' }}>~20× ROI</strong> at list — and ~40× at founding — before counting audit trail, error reduction, or governance. Month-to-month, cancel anytime.
          </p>
        </div>

        {/* Elevator pitch callout */}
        <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.25)', borderLeft: '3px solid #38bdf8', borderRadius: '0.75rem', padding: '1.5rem 1.75rem', maxWidth: '680px' }}>
          <div style={{ fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>The 30-Second Version</div>
          <p style={{ fontSize: '1rem', color: '#e2e8f0', lineHeight: 1.7, margin: 0, fontStyle: 'italic' }}>
            "Your recruiters already pay for ChatGPT or Claude. AskToAct makes it actually do something inside their ATS — with their own Bullhorn permissions enforced server-side, duplicate-proof writes, and a full audit trail on every action. They don't replace the AI. They don't replace the ATS. We close the loop between them. Live in under 30 minutes. No IT department required."
          </p>
        </div>
      </div>

      <div style={{ maxWidth: '960px', margin: '0 auto', padding: '0 4rem 6rem' }}>

        {/* Key stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '4rem' }}>
          <Stat number="~$1,560" label="Monthly productivity lost per recruiter seat to AI copy-paste (6h/wk × $60/hr burdened). A 10-seat desk loses ~$15,600/mo; AskToAct costs $789/mo for those 10 seats — a ~20× return." />
          <Stat number="$0" label="Audit trail at competing firms — no system captures what the AI was asked to do, what it returned, or what changed" accent="#fbbf24" />
          <Stat number="62+" label={`Recruiting actions live in production: ${TOOL_SUMMARY} — search, read, submit, note, status changes, jobs, companies, contacts, tasks, placements, résumé upload — directly from ChatGPT or Claude`} accent="#4ade80" />
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
            The first Bullhorn connector covers {TOOL_SUMMARY} across the complete recruiting workflow. On the read side:
            candidate search and profile reads, contact and company lookup, résumé reads, and live reporting. On the write side:
            submissions and pipeline status changes, note writing, job/company/contact create and update, tasks and appointments,
            tearsheet curation, placement recording, and résumé/file upload with new-candidate creation. Every write tool
            runs under the recruiter's own Bullhorn OAuth session — not a shared service account — so Bullhorn's own
            permission gates enforce what each user can and cannot do, with server-side field validation and duplicate guards
            before every write. The implementation is live and in production.
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

        {/* Why It's a No-Brainer callout */}
        <div style={{ background: 'rgba(56,189,248,0.04)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '1rem', padding: '2rem 2.25rem', marginBottom: '3rem' }}>
          <div style={{ fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Why It's a No-Brainer</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1.5rem' }}>
            <NoBrainerItem icon="✓" title="Zero lock-in" body="Built on MCP — the open standard adopted by ChatGPT, Claude, and Gemini. If a better model launches tomorrow, it still works. Customers aren't betting on a proprietary platform." />
            <NoBrainerItem icon="✓" title="Minimal setup" body="Self-serve onboarding: admin provisions seats, recruiters connect their own Bullhorn accounts via OAuth, paste a URL into ChatGPT. Live in under 30 minutes. No IT department, no implementation project." />
            <NoBrainerItem icon="✓" title="Month-to-month, cancel anytime" body="No long-term commitment required. The product has to earn its place on the budget every month. That's the model — and it's by design." />
            <NoBrainerItem icon="✓" title="Works with AI they already have" body="AskToAct doesn't sell an AI assistant. It connects to whatever the customer already pays for — ChatGPT, Claude, Gemini, or anything else MCP-compatible." />
          </div>
        </div>

        <Divider />

        {/* Section: Business Model */}
        <Section title="How It Makes Money" index="04">
          <p style={bodyStyle}>
            AskToAct runs on stacked recurring streams plus an optional onboarding fee. Infrastructure cost per seat is low;
            the AI cost is borne entirely by the customer. Against a typical staffing stack — Bullhorn at $99–$165/user/month
            plus ChatGPT at $25–$30/user — AskToAct is an incremental bridge, not another full platform license.
          </p>

          <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '0.75rem', padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
            <div style={{ fontSize: '0.7rem', color: '#38bdf8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Recommended · Founding customer conversion (post-pilot)</div>
            <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1.25rem', color: '#f8fafc', marginBottom: '0.35rem' }}>
              ${FOUNDING_PRICING.flatUpTo10Seats}/mo · {FOUNDING_PRICING.includes}
            </div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.5 }}>{FOUNDING_PRICING.note}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', margin: '2rem 0' }}>
            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>List pricing · Wired in Stripe today</div>
              <RevenueRow label={`Platform · $${LIST_PRICING.platform} / mo`} desc="Base access, admin dashboard, audit logs, 1 ATS connector included" />
              <RevenueRow label={`Per-active-seat · $${LIST_PRICING.perActiveSeat} / mo`} desc="Only billed when a seat makes at least one AI call that month — idle seats cost nothing" />
              <RevenueRow label={`Additional connectors · $${LIST_PRICING.additionalConnector} / mo`} desc="Each system beyond the first (roadmap: Salesforce, Workday, Greenhouse…)" />
              <div style={{ borderTop: '1px solid #1e3a5f', marginTop: '1.25rem', paddingTop: '1.25rem' }}>
                <RevenueRow label={`White-glove setup · $${LIST_PRICING.whiteGloveSetup.toLocaleString()} · Optional`} desc="Guided setup, training, OAuth registration. Self-serve is free. Most firms don't need this." gold />
              </div>
              <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: '0.5rem', padding: '0.875rem 1rem', marginTop: '1rem' }}>
                <div style={{ fontSize: '0.75rem', color: '#38bdf8', marginBottom: '0.25rem', fontWeight: 600 }}>No-commitment terms</div>
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', lineHeight: 1.5 }}>Month-to-month on all plans. Annual available (onboarding waived). Cancel anytime — no termination fees, no data hostage situations.</div>
              </div>
            </div>

            <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.75rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '1.25rem' }}>Revenue vs. Gross Margin</div>
              <PricingRow seats="10 active seats · founding rate" range={`~$${ROI_10_SEAT.askToActFounding} / mo`} margin="~95% GM" />
              <PricingRow seats="10 active seats · list pricing" range={`~$${ROI_10_SEAT.askToActList} / mo`} margin="~95% GM" />
              <PricingRow seats="25 active seats · 1 connector" range="~$1,200 / mo" margin="~95% GM" />
              <PricingRow seats="50 active seats · 2 connectors" range="~$2,200 / mo" margin="~95% GM" />
              <PricingRow seats="100 active seats · 3 connectors" range="~$4,000 / mo" margin="~96% GM" />
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '1.5rem', lineHeight: 1.5 }}>
                AI cost is borne entirely by the customer. Infrastructure cost per seat is $30–150/mo depending on firm size and falls with volume. Each new seat added is near-zero incremental cost — expansion revenue is effectively pure margin.
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

        {/* Section: Market & whitespace */}
        <Section title="Market Opportunity · Where the Whitespace Is" index="05">
          <p style={bodyStyle}>
            The global staffing and recruiting market runs on legacy ATS platforms — Bullhorn alone serves 10,000+ firms.
            Every desk adopting ChatGPT or Claude creates a new fracture: powerful AI on one side, the system of record on the other,
            and a human recruiter manually bridging the gap. No incumbent owns that middle layer.
          </p>
          <p style={bodyStyle}>
            <strong style={{ color: '#38bdf8' }}>Whitespace #1 — The action layer.</strong> Horizontal iPaaS players (Zapier, Merge, Unified.to)
            solve generic connectivity. They do not enforce per-recruiter Bullhorn permissions, duplicate-proof submission guards,
            locked headline metrics, or recruiting-domain field validation. Bullhorn's own AI is captive to their stack and pricing.
            AskToAct is purpose-built middleware for "bring your own AI" — the layer every staffing firm will need as AI adoption accelerates.
          </p>
          <p style={bodyStyle}>
            <strong style={{ color: '#38bdf8' }}>Whitespace #2 — Governance.</strong> When recruiters paste AI output into Bullhorn manually,
            there is no record of the prompt, the model's reasoning, or the before/after state. Enterprise buyers and compliance teams
            are starting to ask. AskToAct logs every tool call with firm and user attribution from day one.
          </p>
          <p style={bodyStyle}>
            Near-term ICP: mid-market staffing firms (10–100 recruiters) on Bullhorn who already pay for ChatGPT Team or Enterprise
            and lack engineering resources to build native integrations. Long-term: required middleware for the recruiting stack —
            the open MCP standard (ChatGPT, Claude, Gemini) means the wedge compounds with every connected system.
          </p>
        </Section>

        <Divider />

        {/* Section: Live Deployment */}
        <Section title="Design Partners · Free Pilots in Production" index="06">
          <p style={bodyStyle}>
            The Bullhorn connector is deployed on Railway at connect.asktoact.ai with Supabase-backed multi-tenant data.
            We are running <strong>complimentary pilots</strong> with our first two design-partner firms — not paying customers yet,
            but live on production infrastructure with real recruiters:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', margin: '1.5rem 0' }}>
            {PILOT_FIRMS.map((f) => (
              <div key={f.name} style={{ background: '#102541', border: '1px solid #4ade80', borderRadius: '0.75rem', padding: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  <div style={{ width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#4ade80' }} />
                  <span style={{ fontSize: '0.7rem', color: '#4ade80', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Free pilot · Live</span>
                </div>
                <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1.1rem', marginBottom: '0.35rem' }}>{f.name}</div>
                <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>{f.note}</div>
              </div>
            ))}
          </div>
          <div style={{ background: '#102541', border: '1px solid #1e3a5f', borderRadius: '0.75rem', padding: '1.5rem', marginBottom: '1.5rem' }}>
            <p style={{ fontSize: '1rem', color: '#cbd5e1', lineHeight: 1.7, margin: 0 }}>
              {TOOL_SUMMARY} on Bullhorn, per-user OAuth enforced, full audit logging active. Recruiters search candidates,
              read profiles and résumés, create and advance submissions, add notes, manage jobs and contacts, record placements,
              and upload résumés — directly from ChatGPT or Claude, with no elevated permissions and no manual copy-paste.
              This is not a prototype. It is a functioning product on a real ATS with a production custom domain.
            </p>
          </div>
          <p style={bodyStyle}>
            The path to revenue is converting these pilots to paying founding customers, then using their usage data and
            field-mapping learnings as the case study for the next ten firms. Pilots validate pricing, onboarding friction,
            and the ROI narrative — not product feasibility.
          </p>
        </Section>

        <Divider />

        {/* Section: What We Need */}
        <Section title="Next Steps · Convert Pilots, Expand Pipeline" index="07">
          <p style={bodyStyle}>
            The product is live on Railway, billing is wired in Stripe, and self-serve onboarding is deployed.
            Myticas and STSI are running complimentary production pilots — the next actions are usage review,
            founding-customer conversion, and pipeline expansion. No product sprint required.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem', margin: '1.75rem 0' }}>
            <AskCard number="1" title="Pilot check-ins" body="30-day reviews with Myticas and STSI: usage data, recruiter feedback, field-mapping gaps, and ROI signals. Decide founding-customer conversion timing." />
            <AskCard number="2" title="Convert to founding pricing" body={`Offer ${FOUNDING_PRICING.label.toLowerCase()}: $${FOUNDING_PRICING.flatUpTo10Seats}/mo for up to 10 active seats, month-to-month. Walk away if ROI isn't there — but the math should be obvious.`} />
            <AskCard number="3" title="Expand pipeline" body="Use dual-pilot proof to approach the next 3–5 mid-market Bullhorn firms. Customer brief at connect.asktoact.ai/exec-summary/customer is ready to send." />
          </div>
          <p style={bodyStyle}>
            AskToAct does not need more product to start selling. The connector is live, the billing layer is built,
            and two design-partner pilots are running in production. The next action is conversion and outbound — not a sprint.
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

function PricingRow({ seats, range, margin }: { seats: string; range: string; margin?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '1px solid #1e3a5f', paddingBottom: '0.75rem', marginBottom: '0.75rem' }}>
      <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.9rem', color: '#cbd5e1' }}>{seats}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 700, fontSize: '1rem', color: '#38bdf8' }}>{range}</span>
        {margin && <span style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.75rem', color: '#4ade80' }}>{margin}</span>}
      </div>
    </div>
  );
}

function NoBrainerItem({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.875rem' }}>
      <div style={{ flexShrink: 0, width: '1.5rem', height: '1.5rem', borderRadius: '50%', background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: '#38bdf8', fontWeight: 700 }}>{icon}</div>
      <div>
        <div style={{ fontFamily: '"Sora", system-ui, sans-serif', fontWeight: 600, fontSize: '0.95rem', color: '#f8fafc', marginBottom: '0.25rem' }}>{title}</div>
        <div style={{ fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.6 }}>{body}</div>
      </div>
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
