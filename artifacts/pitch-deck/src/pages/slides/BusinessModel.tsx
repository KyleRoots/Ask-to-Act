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
        <span className="font-body text-[1.2vw] text-muted">AskToAct</span>
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.2vw] leading-[1] tracking-tight text-text max-w-[75vw]">
          Simple per-seat pricing.
          <span className="text-gold"> You don't pay for the AI — your customer does.</span>
        </h1>
      </div>

      <div className="absolute top-[36vh] left-[6vw] right-[6vw] grid grid-cols-2 gap-[3vw]">

        <div className="flex flex-col gap-[1.8vh]">
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Platform · $499 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.45vw] text-muted leading-snug">
              Base access, admin tools, audit logs, 1 ATS connector included.
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Per-active-seat · $29 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.45vw] text-muted leading-snug">
              Only billed when a seat actually uses the bridge that month.
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Additional connectors · $299 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.45vw] text-muted leading-snug">
              Each system beyond the first (Salesforce, Workday, Greenhouse, etc.).
            </div>
          </div>
          <div className="border-l-2 border-gold pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-gold">
              Onboarding · $3,500 one-time
            </div>
            <div className="mt-[0.4vh] font-body text-[1.45vw] text-muted leading-snug">
              Setup, training, OAuth registration. Waived on annual plans.
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-[1.2vw] p-[3vh_2vw]">
          <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-muted">
            Worked Examples · Monthly
          </div>

          <div className="mt-[2vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[2vw] text-text">10 active seats</div>
              <div className="font-body text-[1.1vw] text-muted">1 connector</div>
            </div>
            <div className="font-display font-bold text-[2.2vw] text-accent">~$789 / mo</div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[2vw] text-text">25 active seats</div>
              <div className="font-body text-[1.1vw] text-muted">1 connector</div>
            </div>
            <div className="font-display font-bold text-[2.2vw] text-accent">~$1.2k / mo</div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[2vw] text-text">50 active seats</div>
              <div className="font-body text-[1.1vw] text-muted">2 connectors</div>
            </div>
            <div className="font-display font-bold text-[2.2vw] text-accent">~$2.2k / mo</div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between">
            <div>
              <div className="font-display font-semibold text-[2vw] text-text">100 active seats</div>
              <div className="font-body text-[1.1vw] text-muted">3 connectors</div>
            </div>
            <div className="font-display font-bold text-[2.2vw] text-accent">~$4k / mo</div>
          </div>

          <div className="mt-[2vh] font-body text-[1.2vw] text-muted leading-snug border-t border-line pt-[2vh]">
            Natural expansion: firms add seats as AI proves its value to the desk. Each expansion is incremental revenue with near-zero incremental cost.
          </div>
        </div>

      </div>
    </div>
  );
}
