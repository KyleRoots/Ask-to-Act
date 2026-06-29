import { SlideShell, SlideSubtitle, SlideTitle } from "@/components/SlideShell";

export default function Solution() {
  return (
    <SlideShell
      section="02 · What AskToAct Does"
      glow="radial-gradient(ellipse at center, rgba(56,189,248,0.08), transparent 60%)"
      title={
        <SlideTitle>
          Plug in, not rip and replace —
          <span className="text-accent"> keep your AI, keep your ATS.</span>
        </SlideTitle>
      }
      subtitle={
        <SlideSubtitle>
          Your team keeps the AI they already pay for. Their ATS stays exactly as-is. AskToAct is the invisible bridge that closes the loop. Live in under 30 minutes, no IT department required.
        </SlideSubtitle>
      }
      footer={
        <p className="font-body pd-small text-muted text-center leading-relaxed">
          62+ Bullhorn actions live · Myticas + STSI on complimentary pilots · The recruiter never sees us — they type, the system responds.
        </p>
      }
    >
      <div className="pd-flow mt-2">
        <FlowCard
          label="The user's AI"
          title="ChatGPT, Claude, Gemini"
          body="Whatever they already pay for. We don't sell the AI."
        />
        <div className="pd-flow-arrow font-display font-bold text-2xl text-accent" aria-hidden>→</div>
        <FlowCard
          label="The action layer"
          title="Permissions. Translation. Audit."
          body="Checks who can do what. Speaks every system. Logs every action."
          highlight
          badge="AskToAct"
        />
        <div className="pd-flow-arrow font-display font-bold text-2xl text-accent" aria-hidden>→</div>
        <FlowCard
          label="The stack"
          title="ATS, CRM, HRIS"
          body="Bullhorn first. Then Salesforce, Workday, ADP, and more."
        />
      </div>
    </SlideShell>
  );
}

function FlowCard({
  label,
  title,
  body,
  highlight,
  badge,
}: {
  label: string;
  title: string;
  body: string;
  highlight?: boolean;
  badge?: string;
}) {
  return (
    <div
      className={`pd-flow-card flex flex-col justify-center relative ${
        highlight
          ? "bg-accent/10 border-2 border-accent"
          : "bg-surface border border-line"
      }`}
    >
      {badge ? (
        <div className="absolute -top-3 left-4 bg-accent text-bg font-display font-bold text-[0.65rem] sm:text-xs tracking-[0.2em] uppercase px-3 py-1 rounded-full">
          {badge}
        </div>
      ) : null}
      <div className={`font-display pd-eyebrow tracking-[0.2em] uppercase ${highlight ? "text-accent mt-2" : "text-muted"}`}>
        {label}
      </div>
      <div className="mt-2 font-display font-bold pd-h2 leading-tight text-text">{title}</div>
      <div className="mt-2 font-body pd-small text-muted leading-snug">{body}</div>
    </div>
  );
}
