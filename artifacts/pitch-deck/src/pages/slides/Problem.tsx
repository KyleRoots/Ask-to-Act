import { LogoWordmark } from "@/components/Logo";

export default function Problem() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_rgba(56,189,248,0.10),_transparent_55%)]" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1vw]">
          <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent" />
          <span className="font-display text-[1.2vw] tracking-[0.3em] uppercase text-muted">
            01 · The Problem
          </span>
        </div>
        <LogoWordmark vw={2.2} />
      </div>

      <div className="absolute top-[18vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[5.4vw] leading-[0.98] tracking-tight text-text max-w-[70vw]">
          Recruiters pay a copy-paste tax
          <span className="text-accent"> every single day.</span>
        </h1>
        <p className="mt-[3vh] font-body text-[2vw] text-muted max-w-[60vw] leading-relaxed">
          Every minute moving information between an AI tool and the systems that
          run the business is a minute not selling, sourcing, or placing.
        </p>
      </div>

      <div className="absolute bottom-[8vh] left-[6vw] right-[6vw] grid grid-cols-3 gap-[3vw]">
        <div className="border-t border-line pt-[3vh]">
          <div className="font-display font-extrabold text-[7vw] leading-none text-accent tracking-tight">
            6h
          </div>
          <div className="mt-[2vh] font-body text-[1.5vw] text-muted leading-snug">
            Per recruiter per week lost to copy-paste between AI and ATS. At $85/hr burdened cost,{" "}
            <span className="text-text font-display font-semibold">that's ~$2,200/month per desk.</span>
          </div>
        </div>

        <div className="border-t border-line pt-[3vh]">
          <div className="font-display font-extrabold text-[7vw] leading-none text-accent tracking-tight">
            $0
          </div>
          <div className="mt-[2vh] font-body text-[1.5vw] text-muted leading-snug">
            Audit trail of what an AI was asked, what it returned, what changed. Zero. At any firm.
          </div>
        </div>

        <div className="border-t-2 border-gold pt-[3vh]">
          <div className="font-display font-extrabold text-[7vw] leading-none text-gold tracking-tight">
            $789
          </div>
          <div className="mt-[2vh] font-body text-[1.5vw] text-muted leading-snug">
            AskToAct for a 10-seat desk — per month, no commitment.{" "}
            <span className="text-text font-display font-semibold">ROI positive from week one.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
