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
        <span className="font-body text-[1.2vw] text-muted">AskToAct</span>
      </div>

      <div className="absolute top-[20vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[5.6vw] leading-[0.98] tracking-tight text-text max-w-[75vw]">
          Three decisions
          <span className="text-accent"> from this room.</span>
        </h1>
      </div>

      <div className="absolute top-[46vh] left-[6vw] right-[6vw] grid grid-cols-3 gap-[3vw]">

        <div className="flex flex-col gap-[2vh] border-t-2 border-accent pt-[3vh]">
          <div className="font-display font-extrabold text-[2.4vw] text-text leading-tight">
            Resource alignment
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            Confirm budget envelope and engineering hours through first paid customer.
          </div>
        </div>

        <div className="flex flex-col gap-[2vh] border-t-2 border-accent pt-[3vh]">
          <div className="font-display font-extrabold text-[2.4vw] text-text leading-tight">
            Timeline approval
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            Sign off on the path to multi-system support and onboarding the first three firms.
          </div>
        </div>

        <div className="flex flex-col gap-[2vh] border-t-2 border-gold pt-[3vh]">
          <div className="font-display font-extrabold text-[2.4vw] text-text leading-tight">
            Go / No-go
          </div>
          <div className="font-body text-[1.5vw] text-muted leading-snug">
            A clear green light to begin commercializing — or the specific objections to address first.
          </div>
        </div>

      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] flex items-end justify-between">
        <div className="font-display font-bold text-[3.6vw] text-text leading-tight max-w-[70vw]">
          AskToAct
          <span className="text-muted font-display font-medium text-[2.2vw]"> · We sell the rails, not the chatbot.</span>
        </div>
        <div className="font-body text-[1.3vw] text-muted">
          End of briefing
        </div>
      </div>
    </div>
  );
}
