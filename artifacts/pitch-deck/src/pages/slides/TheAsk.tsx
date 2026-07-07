import { LogoWordmark } from "@/components/Logo";
import { SlideShell, SlideSubtitle, SlideTitle } from "@/components/SlideShell";
import { CONNECTOR_BUILD_PRICING, FOUNDING_PRICING, LIST_PRICING } from "@workspace/gtm";

const ASKS = [
  {
    title: "Pilot check-ins",
    body: "30-day reviews with Myticas and STSI: usage, recruiter feedback, ROI signals. Decide when to convert to founding pricing.",
    accent: "accent" as const,
  },
  {
    title: "Convert pilots",
    body: `Founding rate: $${FOUNDING_PRICING.flatUpTo10Seats}/mo for up to 10 active seats, month-to-month. List pricing ($${LIST_PRICING.platform} + $${LIST_PRICING.perActiveSeat}/seat) after founding cohort. Non-Bullhorn firms: ${CONNECTOR_BUILD_PRICING.rangeLabel} connector build, then MRR.`,
    accent: "accent" as const,
  },
  {
    title: "Send the customer brief",
    body: "connect.asktoact.ai/exec-summary/customer: share with the next 3–5 Bullhorn firms in pipeline.",
    accent: "gold" as const,
  },
];

export default function TheAsk() {
  return (
    <SlideShell
      section="05 · What We Need"
      accent="gold"
      glow="radial-gradient(ellipse at bottom left, rgba(56,189,248,0.18), transparent 55%), radial-gradient(ellipse at top right, rgba(251,191,36,0.10), transparent 55%)"
      title={
        <SlideTitle>
          Pilots are live.
          <span className="text-accent"> Convert and expand.</span>
        </SlideTitle>
      }
      subtitle={
        <SlideSubtitle>
          Myticas and STSI are running complimentary production pilots on connect.asktoact.ai, with 62+ Bullhorn actions live.
          Next: 30-day check-ins, founding-customer conversion at ${FOUNDING_PRICING.flatUpTo10Seats}/mo, and outbound to the next firms.
        </SlideSubtitle>
      }
      footer={
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div className="flex flex-col gap-2 max-w-[36rem]">
            <LogoWordmark vw={3} />
            <span className="font-body pd-small text-muted leading-snug">We sell the rails, not the chatbot.</span>
          </div>
          <div className="font-body pd-small text-muted md:text-right shrink-0">
            <div className="text-accent font-display font-semibold">connect.asktoact.ai</div>
            <div>Live in production today</div>
          </div>
        </div>
      }
    >
      <div className="pd-grid-3 mt-2">
        {ASKS.map((a) => (
          <div key={a.title} className={`border-l-2 pl-4 ${a.accent === "gold" ? "border-gold" : "border-accent"}`}>
            <div className={`font-display pd-eyebrow tracking-[0.15em] uppercase ${a.accent === "gold" ? "text-gold" : "text-accent"}`}>{a.title}</div>
            <div className="mt-2 font-body pd-small text-muted leading-snug">{a.body}</div>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}
