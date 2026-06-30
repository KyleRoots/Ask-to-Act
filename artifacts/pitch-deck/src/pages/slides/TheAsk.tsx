import { LogoWordmark } from "@/components/Logo";
import { SlideShell, SlideSubtitle, SlideTitle } from "@/components/SlideShell";

const ASKS = [
  {
    title: "Pilot check-ins",
    body: "30-day reviews with Myticas and STSI: usage, recruiter feedback, ROI signals. Decide when to convert to founding pricing.",
    accent: "accent" as const,
  },
  {
    title: "Convert pilots",
    body: "Founding rate: $399/mo for up to 10 active seats, month-to-month. List pricing ($499 + $29/seat) after founding cohort.",
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
          Next: 30-day check-ins, founding-customer conversion at $399/mo, and outbound to the next firms.
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
      <div className="pd-grid-3 mt-2 md:mt-4">
        {ASKS.map((a) => (
          <div
            key={a.title}
            className={`flex flex-col gap-3 border-t-2 pt-4 md:pt-6 ${a.accent === "gold" ? "border-gold" : "border-accent"}`}
          >
            <div className="font-display font-extrabold pd-body text-text leading-tight">{a.title}</div>
            <div className="font-body pd-small text-muted leading-snug">{a.body}</div>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}
