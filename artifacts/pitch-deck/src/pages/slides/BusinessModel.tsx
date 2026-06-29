import { SlideShell, SlideSubtitle, SlideTitle } from "@/components/SlideShell";

export default function BusinessModel() {
  return (
    <SlideShell
      section="03 · How It Makes Money"
      accent="gold"
      glow="radial-gradient(ellipse at bottom right, rgba(251,191,36,0.10), transparent 55%)"
      title={
        <SlideTitle>
          The ROI math is obvious.
          <span className="text-gold"> The price isn't the barrier.</span>
        </SlideTitle>
      }
      subtitle={
        <SlideSubtitle>
          Month-to-month. Cancel anytime. No long-term commitment required.
          <span className="text-text font-display font-semibold"> ~95% gross margin at every tier.</span>
        </SlideSubtitle>
      }
    >
      <div className="pd-grid-2 mt-2">
        <div className="flex flex-col gap-4">
          <PricingLine title="Platform · $499 / mo" body="Base access, admin tools, audit logs, 1 ATS connector included." />
          <PricingLine title="Per-active-seat · $29 / mo" body="Only billed when a seat actually uses the bridge that month. Idle seats cost nothing." />
          <PricingLine title="Additional connectors · $299 / mo" body="Each system beyond the first (Salesforce, Workday, Greenhouse, etc.)." />
          <PricingLine title="White-glove setup · $3,500 · Optional" body="Guided setup, training, OAuth registration. Self-serve is free." muted />

          <div className="bg-gold/10 border border-gold/30 rounded-lg px-4 py-3">
            <div className="font-display pd-eyebrow tracking-[0.15em] uppercase text-gold mb-1">Founding customer · post-pilot</div>
            <div className="font-body pd-small text-muted leading-snug">
              <span className="text-text font-display font-semibold">$399 / mo</span> flat · up to 10 active seats · 1 connector · month-to-month
            </div>
          </div>

          <div className="bg-accent/8 border border-accent/30 rounded-lg px-4 py-3">
            <div className="font-display pd-eyebrow tracking-[0.15em] uppercase text-accent mb-1">List pricing · 10-seat desk</div>
            <div className="font-body pd-small text-muted leading-snug">
              Cost: <span className="text-text font-display font-semibold">$789 / mo</span> · Value recovered:{" "}
              <span className="text-gold font-display font-semibold">~$15,600 / mo</span>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-xl p-5 md:p-6">
          <div className="font-display pd-eyebrow tracking-[0.15em] uppercase text-muted">Monthly · Revenue vs. Margin</div>
          <MarginRow seats="10 seats · 1 connector" infra="~$30–40 infra / mo" revenue="~$789 / mo" margin="~95% GM" />
          <MarginRow seats="25 seats · 1 connector" infra="~$40–60 infra / mo" revenue="~$1.2k / mo" margin="~95% GM" />
          <MarginRow seats="50 seats · 2 connectors" infra="~$60–100 infra / mo" revenue="~$2.2k / mo" margin="~95% GM" />
          <MarginRow seats="100 seats · 3 connectors" infra="~$100–150 infra / mo" revenue="~$4k / mo" margin="~96% GM" last />
          <p className="mt-4 pt-4 border-t border-line font-body pd-small text-muted leading-snug">
            AI cost is borne by the customer. Infrastructure cost per seat falls with volume. Each new seat is near-zero incremental cost.
          </p>
        </div>
      </div>
    </SlideShell>
  );
}

function PricingLine({ title, body, muted }: { title: string; body: string; muted?: boolean }) {
  return (
    <div className={`border-l-2 pl-4 ${muted ? "border-line" : "border-accent"}`}>
      <div className={`font-display pd-eyebrow tracking-[0.15em] uppercase ${muted ? "text-muted" : "text-accent"}`}>{title}</div>
      <div className="mt-1 font-body pd-small text-muted leading-snug">{body}</div>
    </div>
  );
}

function MarginRow({
  seats,
  infra,
  revenue,
  margin,
  last,
}: {
  seats: string;
  infra: string;
  revenue: string;
  margin: string;
  last?: boolean;
}) {
  return (
    <div className={`mt-4 flex flex-wrap items-baseline justify-between gap-2 ${last ? "" : "border-b border-line pb-4"}`}>
      <div>
        <div className="font-display font-semibold pd-body text-text">{seats}</div>
        <div className="font-body pd-small text-muted">{infra}</div>
      </div>
      <div className="text-right">
        <div className="font-display font-bold pd-body text-accent">{revenue}</div>
        <div className="font-body pd-small text-gold">{margin}</div>
      </div>
    </div>
  );
}
