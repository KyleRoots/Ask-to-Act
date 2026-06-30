import { LogoWordmark } from "@/components/Logo";

export default function Cover() {
  return (
    <div className="pd-slide relative bg-bg text-text w-full min-h-[100dvh] flex flex-col overflow-x-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(79,70,229,0.22),_transparent_55%)] pointer-events-none" aria-hidden />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(56,189,248,0.14),_transparent_50%)] pointer-events-none" aria-hidden />

      <header className="relative z-10 pd-slide-x pd-slide-pt pb-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2 min-w-0">
          <LogoWordmark vw={3} />
          <span className="font-display pd-eyebrow tracking-[0.25em] uppercase text-muted leading-snug">
            Investor & Customer Briefing
          </span>
        </div>
        <div className="pd-cover-meta text-muted">
          <span className="flex items-center gap-1.5 text-green-400 font-body font-medium">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse shrink-0" />
            Live · connect.asktoact.ai
          </span>
          <span className="font-body hidden sm:inline">Confidential · 2026</span>
        </div>
      </header>

      <main className="relative z-10 pd-slide-x flex flex-col justify-start md:justify-center gap-[clamp(1rem,2.5vh,2rem)] py-6">
        <div className="font-display font-extrabold pd-cover-title leading-[0.92] tracking-tight">
          <span className="bg-gradient-to-br from-white via-white to-sky-300 bg-clip-text text-transparent">AskToAct</span>
        </div>
        <div className="font-display font-medium pd-cover-tagline leading-tight tracking-tight text-text max-w-[36rem]">
          We sell the rails,
          <span className="bg-gradient-to-r from-indigo-300 via-sky-400 to-cyan-300 bg-clip-text text-transparent"> not the chatbot.</span>
        </div>
        <div className="inline-flex self-start items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/15 border border-indigo-400/30 max-w-full">
          <span className="font-body pd-small text-indigo-200 font-semibold leading-snug">
            62+ Bullhorn actions · Myticas + STSI live
          </span>
        </div>
        <p className="font-body pd-body text-muted max-w-[36rem] leading-relaxed">
          The recruiter types in ChatGPT. The right thing happens in Bullhorn, with their own permissions enforced, every action audited, and no copy-paste in between.
        </p>
      </main>

      <footer className="relative z-10 pd-slide-x pd-slide-pb pt-4 border-t border-line/40 flex flex-wrap items-center justify-between gap-3 font-body pd-small text-muted">
        <span>Prepared for partners & prospects</span>
        <span>10-minute walkthrough</span>
      </footer>
    </div>
  );
}
