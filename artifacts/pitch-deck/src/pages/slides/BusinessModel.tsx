import { LogoWordmark } from "@/components/Logo";

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
        <LogoWordmark vw={2.2} />
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.2vw] leading-[1] tracking-tight text-text max-w-[75vw]">
          The ROI math is obvious.
          <span className="text-gold"> The price isn't the barrier.</span>
        </h1>
        <p className="mt-[1.5vh] font-body text-[1.7vw] text-muted">
          Month-to-month. Cancel anytime. No long-term commitment required.
          <span className="text-text font-display font-semibold"> ~85% gross margin at every tier.</span>
        </p>
      </div>

      <div className="absolute top-[38vh] left-[6vw] right-[6vw] grid grid-cols-2 gap-[3vw]">

        <div className="flex flex-col gap-[1.6vh]">
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Platform · $499 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.35vw] text-muted leading-snug">
              Base access, admin tools, audit logs, 1 ATS connector included.
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Per-active-seat · $29 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.35vw] text-muted leading-snug">
              Only billed when a seat actually uses the bridge that month. Idle seats cost nothing.
            </div>
          </div>
          <div className="border-l-2 border-accent pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-accent">
              Additional connectors · $299 / mo
            </div>
            <div className="mt-[0.4vh] font-body text-[1.35vw] text-muted leading-snug">
              Each system beyond the first (Salesforce, Workday, Greenhouse, etc.).
            </div>
          </div>
          <div className="border-l-2 border-line pl-[1.2vw]">
            <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-muted">
              White-glove setup · $3,500 · Optional
            </div>
            <div className="mt-[0.4vh] font-body text-[1.35vw] text-muted leading-snug">
              Guided setup, training, OAuth registration. Self-serve is free. Most firms don't need this.
            </div>
          </div>

          <div className="mt-[0.5vh] bg-gold/10 border border-gold/30 rounded-[0.8vw] px-[1.2vw] py-[1.2vh]">
            <div className="font-display text-[1.05vw] tracking-[0.2em] uppercase text-gold mb-[0.6vh]">
              Founding customer · post-pilot
            </div>
            <div className="font-body text-[1.3vw] text-muted leading-snug">
              <span className="text-text font-display font-semibold">$399 / mo</span>
              {" "}flat · up to 10 active seats · 1 connector · month-to-month
            </div>
          </div>

          <div className="mt-[0.5vh] bg-accent/8 border border-accent/30 rounded-[0.8vw] px-[1.2vw] py-[1.2vh]">
            <div className="font-display text-[1.05vw] tracking-[0.2em] uppercase text-accent mb-[0.6vh]">
              List pricing · 10-seat desk
            </div>
            <div className="font-body text-[1.3vw] text-muted leading-snug">
              Cost of AskToAct: <span className="text-text font-display font-semibold">$789 / mo</span>
              {" "}·{" "}
              Value recovered: <span className="text-gold font-display font-semibold">~$15,600 / mo</span>
              <br />
              <span className="text-[1.1vw]">vs. Bullhorn ($99–165/user) + ChatGPT ($25–30/user) with no bridge between them.</span>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-line rounded-[1.2vw] p-[3vh_2vw]">
          <div className="font-display text-[1.1vw] tracking-[0.2em] uppercase text-muted">
            Monthly · Revenue vs. Margin
          </div>

          <div className="mt-[2vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[1.9vw] text-text">10 seats · 1 connector</div>
              <div className="font-body text-[1.1vw] text-muted">~$30–40 infra / mo</div>
            </div>
            <div className="text-right">
              <div className="font-display font-bold text-[2vw] text-accent">~$789 / mo</div>
              <div className="font-body text-[1.1vw] text-gold">~95% gross margin</div>
            </div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[1.9vw] text-text">25 seats · 1 connector</div>
              <div className="font-body text-[1.1vw] text-muted">~$40–60 infra / mo</div>
            </div>
            <div className="text-right">
              <div className="font-display font-bold text-[2vw] text-accent">~$1.2k / mo</div>
              <div className="font-body text-[1.1vw] text-gold">~95% gross margin</div>
            </div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between border-b border-line pb-[1.5vh]">
            <div>
              <div className="font-display font-semibold text-[1.9vw] text-text">50 seats · 2 connectors</div>
              <div className="font-body text-[1.1vw] text-muted">~$60–100 infra / mo</div>
            </div>
            <div className="text-right">
              <div className="font-display font-bold text-[2vw] text-accent">~$2.2k / mo</div>
              <div className="font-body text-[1.1vw] text-gold">~95% gross margin</div>
            </div>
          </div>

          <div className="mt-[1.5vh] flex items-baseline justify-between">
            <div>
              <div className="font-display font-semibold text-[1.9vw] text-text">100 seats · 3 connectors</div>
              <div className="font-body text-[1.1vw] text-muted">~$100–150 infra / mo</div>
            </div>
            <div className="text-right">
              <div className="font-display font-bold text-[2vw] text-accent">~$4k / mo</div>
              <div className="font-body text-[1.1vw] text-gold">~96% gross margin</div>
            </div>
          </div>

          <div className="mt-[2vh] font-body text-[1.15vw] text-muted leading-snug border-t border-line pt-[2vh]">
            AI cost is borne by the customer. Infrastructure cost per seat falls with volume.
            Each new seat is near-zero incremental cost — expansion is pure margin.
          </div>
        </div>

      </div>
    </div>
  );
}
