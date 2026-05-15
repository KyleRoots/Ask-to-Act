export default function BusinessModel() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_rgba(251,191,36,0.10),_transparent_55%)]" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1vw]">
          <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-gold" />
          <span className="font-display text-[1.2vw] tracking-[0.3em] uppercase text-muted">
            03 · How It Makes Money
          </span>
        </div>
        <span className="font-body text-[1.2vw] text-muted">Relay</span>
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.6vw] leading-[1] tracking-tight text-text max-w-[70vw]">
          Three recurring streams,
          <span className="text-gold"> one onboarding fee.</span>
        </h1>
      </div>

      <div className="absolute top-[36vh] left-[6vw] right-[6vw] grid grid-cols-2 gap-[3vw]">

        <div className="flex flex-col gap-[2vh]">
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.2vw] tracking-[0.2em] uppercase text-accent">
              Platform fee
            </div>
            <div className="mt-[0.5vh] font-body text-[1.6vw] text-muted leading-snug">
              Base subscription per customer firm.
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.2vw] tracking-[0.2em] uppercase text-accent">
              Per-system fee
            </div>
            <div className="mt-[0.5vh] font-body text-[1.6vw] text-muted leading-snug">
              Each connected system (Bullhorn, Salesforce, etc.).
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.2vw] tracking-[0.2em] uppercase text-accent">
              Per-active-seat
            </div>
            <div className="mt-[0.5vh] font-body text-[1.6vw] text-muted leading-snug">
              Only billed when a seat actually uses the bridge.
            </div>
          </div>
          <div className="border-l-2 border-gold pl-[1.2vw]">
            <div className="font-display text-[1.2vw] tracking-[0.2em] uppercase text-gold">
              Onboarding · One-time
            </div>
            <div className="mt-[0.5vh] font-body text-[1.6vw] text-muted leading-snug">
              $2,500–$5,000 per firm. Compliance tier as add-on.
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-[1.2vw] p-[3vh_2vw]">
          <div className="font-display text-[1.2vw] tracking-[0.2em] uppercase text-muted">
            Worked Examples · Monthly
          </div>

          <div className="mt-[2.5vh] flex items-baseline justify-between border-b border-line pb-[2vh]">
            <div className="font-display font-semibold text-[2.4vw] text-text">10 seats</div>
            <div className="font-display font-bold text-[2.4vw] text-accent">$1.5k–2k</div>
          </div>

          <div className="mt-[2vh] flex items-baseline justify-between border-b border-line pb-[2vh]">
            <div className="font-display font-semibold text-[2.4vw] text-text">50 seats</div>
            <div className="font-display font-bold text-[2.4vw] text-accent">$4.5k–6k</div>
          </div>

          <div className="mt-[2vh] flex items-baseline justify-between">
            <div className="font-display font-semibold text-[2.4vw] text-text">100 seats</div>
            <div className="font-display font-bold text-[2.4vw] text-accent">$8k–12k</div>
          </div>

          <div className="mt-[3vh] font-body text-[1.3vw] text-muted leading-snug">
            Pricing scales with usage and breadth. Margin stays high — we don't pay for the AI, the customer does.
          </div>
        </div>

      </div>
    </div>
  );
}
