import { SlideShell, SlideStat, SlideSubtitle, SlideTitle } from "@/components/SlideShell";

export default function Problem() {
  return (
    <SlideShell
      section="01 · The Problem"
      glow="radial-gradient(ellipse at top left, rgba(56,189,248,0.10), transparent 55%)"
      title={
        <SlideTitle>
          Recruiters pay a copy-paste tax
          <span className="text-accent"> every single day.</span>
        </SlideTitle>
      }
      subtitle={
        <SlideSubtitle>
          Every minute moving information between an AI tool and the systems that run the business is a minute not selling, sourcing, or placing.
        </SlideSubtitle>
      }
    >
      <div className="pd-grid-3 mt-2 md:mt-4">
        <SlideStat
          value="6h"
          label={
            <>
              Per recruiter per week lost to copy-paste between AI and ATS. At $60/hr burdened cost,{" "}
              <span className="text-text font-display font-semibold">that's ~$1,560/month per seat.</span>
            </>
          }
        />
        <SlideStat
          value="$0"
          label="Audit trail of what an AI was asked, what it returned, what changed. Zero. At any firm."
        />
        <SlideStat
          value="$789"
          label={
            <>
              AskToAct list pricing for a 10-seat desk, per month, no commitment.{" "}
              <span className="text-text font-display font-semibold">Founding rate: $399/mo.</span>
            </>
          }
          accentClass="text-gold"
        />
      </div>
    </SlideShell>
  );
}
