import type { ReactNode } from "react";
import { LogoWordmark } from "./Logo";

type Accent = "accent" | "gold";

interface SlideShellProps {
  section: string;
  accent?: Accent;
  title?: ReactNode;
  subtitle?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  glow?: string;
  hideLogo?: boolean;
  className?: string;
}

export function SlideShell({
  section,
  accent = "accent",
  title,
  subtitle,
  footer,
  children,
  glow,
  hideLogo = false,
  className = "",
}: SlideShellProps) {
  const dot = accent === "gold" ? "bg-gold" : "bg-accent";

  return (
    <div className={`pd-slide relative bg-bg text-text w-full min-h-[100dvh] flex flex-col overflow-x-hidden ${className}`}>
      {glow ? (
        <div className="absolute inset-0 pointer-events-none" aria-hidden style={{ background: glow }} />
      ) : null}

      <header className="relative z-10 shrink-0 pd-slide-x pd-slide-pt pb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
          <span className="font-display pd-eyebrow tracking-[0.2em] uppercase text-muted">{section}</span>
        </div>
        {!hideLogo ? (
          <div className="shrink-0 pd-logo-wrap">
            <LogoWordmark vw={3} />
          </div>
        ) : null}
      </header>

      <main className="relative z-10 pd-slide-x pd-slide-pb flex flex-col gap-[clamp(0.75rem,2vh,1.75rem)]">
        {title ? <div className="shrink-0">{title}</div> : null}
        {subtitle ? <div className="shrink-0">{subtitle}</div> : null}
        {children}
      </main>

      {footer ? (
        <footer className="relative z-10 shrink-0 pd-slide-x pd-slide-pb pt-3 mt-auto border-t border-line/50">
          {footer}
        </footer>
      ) : null}
    </div>
  );
}

export function SlideTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h1 className={`font-display font-bold pd-h1 leading-[1.05] tracking-tight text-text max-w-[48rem] ${className}`}>
      {children}
    </h1>
  );
}

export function SlideSubtitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`font-body pd-body text-muted max-w-[42rem] leading-relaxed ${className}`}>
      {children}
    </p>
  );
}

export function SlideStat({ value, label, accentClass = "text-accent" }: { value: string; label: ReactNode; accentClass?: string }) {
  return (
    <div className="border-t border-line pt-4 md:pt-6">
      <div className={`font-display font-extrabold pd-stat leading-none tracking-tight ${accentClass}`}>{value}</div>
      <div className="mt-3 font-body pd-small text-muted leading-snug">{label}</div>
    </div>
  );
}
