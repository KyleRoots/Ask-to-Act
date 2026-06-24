import { LogoWordmark } from "@/components/Logo";

export default function TheAsk() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(56,189,248,0.18),_transparent_55%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(251,191,36,0.10),_transparent_55%)]" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1vw]">
          <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-gold" />
          <span className="font-display text-[1.2vw] tracking-[0.3em] uppercase text-muted">
            05 · What We Need
          </span>
        </div>
        <LogoWordmark vw={2.2} />
      </div>

      <div className="absolute top-[18vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[5.2vw] leading-[0.98] tracking-tight text-text max-w-[75vw]">
          Start a pilot.
          <span className="text-accent"> No commitment required.</span>
        </h1>
        <p className="mt-[2vh] font-body text-[1.9vw] text-muted max-w-[65vw] leading-relaxed">
          The product is live. The billing is wired. The only thing left is a sales call and a 30-day window to prove the ROI. Walk away if it doesn't deliver.
        </p>
      </div>

      <div className="absolute top-[52vh] left-[6vw] right-[6vw] grid grid-cols-3 gap-[3vw]">

        <div className="flex flex-col gap-[2vh] border-t-2 border-accent pt-[3vh]">
          <div className="font-display font-extrabold text-[2.2vw] text-text leading-tight">
            Name a firm
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            Identify one mid-market staffing firm for first commercial outreach. We handle the rest — demo, onboarding, and first month of support.
          </div>
        </div>

        <div className="flex flex-col gap-[2vh] border-t-2 border-accent pt-[3vh]">
          <div className="font-display font-extrabold text-[2.2vw] text-text leading-tight">
            Greenlight the pilot
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            Approve a 30-day paid pilot — month-to-month, no contractual lock-in. If they don't see ROI in 30 days, they cancel. That's the whole ask.
          </div>
        </div>

        <div className="flex flex-col gap-[2vh] border-t-2 border-gold pt-[3vh]">
          <div className="font-display font-extrabold text-[2.2vw] text-text leading-tight">
            Set a check-in
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            30 days from first customer go-live: review usage data, recruiter feedback, and the expansion motion. One meeting, not a committee.
          </div>
        </div>

      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] flex items-end justify-between">
        <div className="font-display font-bold text-[3.2vw] text-text leading-tight max-w-[70vw]">
          AskToAct
          <span className="text-muted font-display font-medium text-[2vw]"> · We sell the rails, not the chatbot.</span>
        </div>
        <div className="font-body text-[1.3vw] text-muted text-right">
          <div className="text-accent font-display font-semibold">connect.asktoact.ai</div>
          <div>Live in production today</div>
        </div>
      </div>
    </div>
  );
}
