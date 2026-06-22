export default function Cover() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(56,189,248,0.18),_transparent_55%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(251,191,36,0.08),_transparent_50%)]" />

      <div className="absolute top-[6vh] left-[6vw] flex items-center gap-[1vw]">
        <div className="w-[1.2vw] h-[1.2vw] rounded-full bg-accent" />
        <span className="font-display text-[1.4vw] tracking-[0.3em] uppercase text-muted">
          Internal Stakeholder Briefing
        </span>
      </div>

      <div className="absolute top-[6vh] right-[6vw] flex items-center gap-[2vw]">
        <div className="flex items-center gap-[0.6vw]">
          <div className="w-[0.6vw] h-[0.6vw] rounded-full bg-green-400 animate-pulse" />
          <span className="font-body text-[1.1vw] text-green-400">Live · connect.asktoact.ai</span>
        </div>
        <span className="font-body text-[1.4vw] text-muted">Confidential · 2026</span>
      </div>

      <div className="absolute left-[6vw] top-[30vh] max-w-[80vw]">
        <div className="font-display font-extrabold text-[9vw] leading-[0.92] tracking-tight text-text">
          AskToAct
        </div>
        <div className="mt-[2.5vh] font-display font-medium text-[3.2vw] leading-tight tracking-tight text-text max-w-[70vw]">
          We sell the rails,
          <span className="text-accent"> not the chatbot.</span>
        </div>
        <div className="mt-[3.5vh] font-body text-[1.65vw] text-muted max-w-[58vw] leading-relaxed">
          The recruiter types in ChatGPT. The right thing happens in Bullhorn — with their own permissions enforced, every action audited, no copy-paste in between.
        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] flex items-end justify-between">
        <div className="font-body text-[1.3vw] text-muted tracking-wide">
          Prepared for internal partners
        </div>
        <div className="font-body text-[1.3vw] text-muted tracking-wide">
          10-minute walkthrough
        </div>
      </div>
    </div>
  );
}
