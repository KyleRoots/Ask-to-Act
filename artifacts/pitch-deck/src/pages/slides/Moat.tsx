import { LogoWordmark } from "@/components/Logo";

export default function Moat() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg text-text">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(56,189,248,0.12),_transparent_55%)]" />

      <div className="absolute top-[7vh] left-[6vw] right-[6vw] flex items-center justify-between">
        <div className="flex items-center gap-[1vw]">
          <div className="w-[0.8vw] h-[0.8vw] rounded-full bg-accent" />
          <span className="font-display text-[1.2vw] tracking-[0.3em] uppercase text-muted">
            04 · Why AskToAct Wins
          </span>
        </div>
        <LogoWordmark vw={2.2} />
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.2vw] leading-[1] tracking-tight text-text max-w-[80vw]">
          The moat is not the integration —
          <span className="text-accent"> it's what sits between the AI and the write.</span>
        </h1>
      </div>

      <div className="absolute top-[36vh] left-[6vw] right-[6vw] grid grid-cols-4 gap-[2vw]">

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[4.5vw] leading-none text-accent">01</div>
          <div className="font-display font-bold text-[1.8vw] text-text leading-tight">
            Model-agnostic
          </div>
          <div className="font-body text-[1.3vw] text-muted leading-snug">
            Works with whatever AI the customer already pays for. As models commoditize, the bridge becomes more valuable, not less.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[4.5vw] leading-none text-accent">02</div>
          <div className="font-display font-bold text-[1.8vw] text-text leading-tight">
            Per-user permissions
          </div>
          <div className="font-body text-[1.3vw] text-muted leading-snug">
            Every write runs under the recruiter's own Bullhorn session — not a shared admin account. IT can deploy without fear of privilege escalation.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[4.5vw] leading-none text-accent">03</div>
          <div className="font-display font-bold text-[1.8vw] text-text leading-tight">
            Data integrity layer
          </div>
          <div className="font-body text-[1.3vw] text-muted leading-snug">
            Duplicate-proof writes, locked headline metrics, validation before every API call. Generic wrappers write whatever the AI says.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[4.5vw] leading-none text-accent">04</div>
          <div className="font-display font-bold text-[1.8vw] text-text leading-tight">
            First-mover on the standard
          </div>
          <div className="font-body text-[1.3vw] text-muted leading-snug">
            Built on the open protocol adopted by ChatGPT, Claude, and Gemini. Domain vocabulary and workflow patterns in place before horizontal players notice the vertical.
          </div>
        </div>

      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] flex items-center justify-between border-t border-line pt-[2.5vh]">
        <div className="font-body text-[1.4vw] text-muted">
          <span className="text-text font-display font-semibold">Customer zero:</span> Myticas Consulting — live in production at{" "}
          <span className="text-accent">connect.asktoact.ai</span>
        </div>
        <div className="font-display text-[1.2vw] tracking-[0.25em] uppercase text-gold">
          Real desk · Real ATS · Live
        </div>
      </div>
    </div>
  );
}
