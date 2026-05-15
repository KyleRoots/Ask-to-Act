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
        <span className="font-body text-[1.2vw] text-muted">AskToAct</span>
      </div>

      <div className="absolute top-[16vh] left-[6vw] right-[6vw]">
        <h1 className="font-display font-bold text-[4.6vw] leading-[1] tracking-tight text-text max-w-[75vw]">
          Four reasons the moat
          <span className="text-accent"> compounds, not erodes.</span>
        </h1>
      </div>

      <div className="absolute top-[36vh] left-[6vw] right-[6vw] grid grid-cols-4 gap-[2vw]">

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[5vw] leading-none text-accent">01</div>
          <div className="font-display font-bold text-[2vw] text-text leading-tight">
            Model-agnostic
          </div>
          <div className="font-body text-[1.4vw] text-muted leading-snug">
            Works with whatever AI the customer already pays for. No lock-in to a single vendor.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[5vw] leading-none text-accent">02</div>
          <div className="font-display font-bold text-[2vw] text-text leading-tight">
            Domain-deep
          </div>
          <div className="font-body text-[1.4vw] text-muted leading-snug">
            Built around how recruiters actually work, not generic API wrappers like the horizontal players ship.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[5vw] leading-none text-accent">03</div>
          <div className="font-display font-bold text-[2vw] text-text leading-tight">
            Governance built in
          </div>
          <div className="font-body text-[1.4vw] text-muted leading-snug">
            Role-based permissions and audit trails from day one. The thing every enterprise buyer asks for first.
          </div>
        </div>

        <div className="flex flex-col gap-[1.5vh]">
          <div className="font-display font-extrabold text-[5vw] leading-none text-accent">04</div>
          <div className="font-display font-bold text-[2vw] text-text leading-tight">
            First-mover on the standard
          </div>
          <div className="font-body text-[1.4vw] text-muted leading-snug">
            Built on the emerging open protocol that ChatGPT, Claude, and others have all adopted.
          </div>
        </div>

      </div>

      <div className="absolute bottom-[5vh] left-[6vw] right-[6vw] flex items-center justify-between border-t border-line pt-[2.5vh]">
        <div className="font-body text-[1.4vw] text-muted">
          <span className="text-text font-display font-semibold">Customer zero:</span> Myticas Consulting, a staffing firm on Bullhorn, already in motion.
        </div>
        <div className="font-display text-[1.2vw] tracking-[0.25em] uppercase text-gold">
          Real desk · Real ATS
        </div>
      </div>
    </div>
  );
}
