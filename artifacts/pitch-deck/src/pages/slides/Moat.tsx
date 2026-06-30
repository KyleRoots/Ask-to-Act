import { SlideShell, SlideTitle } from "@/components/SlideShell";

const MOATS = [
  { n: "01", title: "Model-agnostic", body: "Works with whatever AI the customer already pays for. As models commoditize, the bridge becomes more valuable, not less." },
  { n: "02", title: "Per-user permissions", body: "Every write runs under the recruiter's own Bullhorn session, not a shared admin account. IT can deploy without fear of privilege escalation." },
  { n: "03", title: "Data integrity layer", body: "Duplicate-proof writes, locked headline metrics, validation before every API call. Generic wrappers write whatever the AI says." },
  { n: "04", title: "First-mover on the standard", body: "Built on the open protocol adopted by ChatGPT, Claude, and Gemini. Domain vocabulary in place before horizontal players notice the vertical." },
  { n: "05", title: "Zero lock-in", body: "Built on open standards (MCP). If a better model drops tomorrow, it still works. Customers aren't betting on a proprietary platform.", gold: true },
];

export default function Moat() {
  return (
    <SlideShell
      section="04 · Why AskToAct Wins"
      glow="radial-gradient(ellipse at top right, rgba(56,189,248,0.12), transparent 55%)"
      title={
        <SlideTitle>
          The moat is not the integration:
          <span className="text-accent"> it's what sits between the AI and the write.</span>
        </SlideTitle>
      }
      footer={
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="font-body pd-small text-muted leading-snug">
            <span className="text-text font-display font-semibold">Design partners:</span> Myticas Consulting + STSI, live at{" "}
            <span className="text-accent">connect.asktoact.ai</span>
          </p>
          <div className="font-display pd-eyebrow tracking-[0.2em] uppercase text-gold shrink-0">
            Real desks · Real ATS · Live
          </div>
        </div>
      }
    >
      <div className="pd-grid-5 mt-2">
        {MOATS.map((m) => (
          <div
            key={m.n}
            className={`flex flex-col gap-2 ${m.gold ? "lg:border-l lg:border-accent/30 lg:pl-4" : ""}`}
          >
            <div className={`font-display font-extrabold text-3xl md:text-4xl leading-none ${m.gold ? "text-gold" : "text-accent"}`}>
              {m.n}
            </div>
            <div className="font-display font-bold pd-body text-text leading-tight">{m.title}</div>
            <div className="font-body pd-small text-muted leading-snug">{m.body}</div>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}
