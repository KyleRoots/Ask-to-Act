import { LogoWordmark } from "@/components/Logo";

export default function Solution() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(56,189,248,0.08),_transparent_60%)]" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1vw]">
          <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent" />
          <span className="font-display text-[1.2vw] tracking-[0.3em] uppercase text-muted">
            02 · What AskToAct Does
          </span>
        </div>
        <LogoWordmark vw={2.2} />
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.8vw] leading-[1] tracking-tight text-text max-w-[70vw]">
          Plug in, not rip and replace —
          <span className="text-accent"> keep your AI, keep your ATS.</span>
        </h1>
        <p className="mt-[2vh] font-body text-[1.8vw] text-muted max-w-[65vw] leading-relaxed">
          Your team keeps the AI they already pay for. Their ATS stays exactly as-is. AskToAct is the invisible bridge that closes the loop. Live in under 30 minutes, no IT department required.
        </p>
      </div>

      <div className="absolute top-[42vh] left-[6vw] right-[6vw]">
        <div className="grid grid-cols-[1fr_auto_1.2fr_auto_1fr] gap-[2vw] items-stretch">

          <div className="bg-surface border border-line rounded-[1.2vw] p-[3vh_2vw] flex flex-col justify-center">
            <div className="font-display text-[1.1vw] tracking-[0.25em] uppercase text-muted">
              The user's AI
            </div>
            <div className="mt-[1.5vh] font-display font-bold text-[2.6vw] leading-tight text-text">
              ChatGPT, Claude, Gemini
            </div>
            <div className="mt-[1.5vh] font-body text-[1.3vw] text-muted leading-snug">
              Whatever they already pay for. We don't sell the AI.
            </div>
          </div>

          <div className="flex items-center justify-center">
            <div className="font-display font-bold text-[3vw] text-accent">→</div>
          </div>

          <div className="bg-accent/10 border-2 border-accent rounded-[1.2vw] p-[3vh_2vw] flex flex-col justify-center relative">
            <div className="absolute -top-[2vh] left-[2vw] bg-accent text-bg font-display font-bold text-[1vw] tracking-[0.25em] uppercase px-[1.2vw] py-[0.6vh] rounded-full">
              AskToAct
            </div>
            <div className="font-display text-[1.1vw] tracking-[0.25em] uppercase text-accent mt-[1vh]">
              The action layer
            </div>
            <div className="mt-[1.5vh] font-display font-bold text-[2.4vw] leading-tight text-text">
              Permissions. Translation. Audit.
            </div>
            <div className="mt-[1.5vh] font-body text-[1.3vw] text-muted leading-snug">
              Checks who can do what. Speaks every system. Logs every action.
            </div>
          </div>

          <div className="flex items-center justify-center">
            <div className="font-display font-bold text-[3vw] text-accent">→</div>
          </div>

          <div className="bg-surface border border-line rounded-[1.2vw] p-[3vh_2vw] flex flex-col justify-center">
            <div className="font-display text-[1.1vw] tracking-[0.25em] uppercase text-muted">
              The stack
            </div>
            <div className="mt-[1.5vh] font-display font-bold text-[2.6vw] leading-tight text-text">
              ATS, CRM, HRIS
            </div>
            <div className="mt-[1.5vh] font-body text-[1.3vw] text-muted leading-snug">
              Bullhorn first. Then Salesforce, Workday, ADP, and more.
            </div>
          </div>

        </div>
      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] font-body text-[1.5vw] text-muted text-center">
        The recruiter never sees us. They just type, the system responds, the work gets done.
      </div>
    </div>
  );
}
