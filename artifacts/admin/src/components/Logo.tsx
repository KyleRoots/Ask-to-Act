interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}

export function LogoIcon({ size = 32 }: { size?: number }) {
  const id = `ata-g-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="55%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
        {/* Soft inner glow on badge */}
        <radialGradient id={`${id}-glow`} cx="40%" cy="30%" r="60%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>

      {/* Badge background */}
      <rect width="48" height="48" rx="13" fill={`url(#${id})`} />
      {/* Inner highlight */}
      <rect width="48" height="48" rx="13" fill={`url(#${id}-glow)`} />

      {/*
        Speech bubble — fills most of badge.
        Tail at bottom-center (dialog / chat message style).
        Prominent, centered, modern.
      */}
      <path
        d="
          M11 5
          C11 3.3 12.3 2 14 2
          L34 2
          C35.7 2 37 3.3 37 5
          L37 27
          C37 28.7 35.7 30 34 30
          L27.5 30
          L24 36.5
          L20.5 30
          L14 30
          C12.3 30 11 28.7 11 27
          Z
        "
        fill="white"
        fillOpacity="0.97"
      />

      {/*
        Arrow inside the bubble — indigo so it pops against white.
        Horizontal shaft + arrowhead pointing right.
        Centered vertically in the bubble (bubble body ~y=2–30, center~y=16).
      */}
      <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
      <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

      {/* Three small dots at bottom — hint of "typing" / conversation in progress */}
      <circle cx="20" cy="43" r="1.4" fill="white" fillOpacity="0.55" />
      <circle cx="24" cy="45" r="1.1" fill="white" fillOpacity="0.35" />
      <circle cx="28" cy="43" r="0.8" fill="white" fillOpacity="0.2" />
    </svg>
  );
}

export function LogoWordmark({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`} style={{ userSelect: "none" }}>
      <LogoIcon size={size} />
      <span
        style={{
          fontSize: Math.round(size * 0.52),
          fontWeight: 800,
          letterSpacing: "-0.025em",
          lineHeight: 1,
        }}
        className="text-white"
      >
        Ask<span style={{ color: "#38BDF8" }}>To</span>Act
      </span>
    </div>
  );
}

export default function Logo({ size = 32, showWordmark = true, className = "" }: LogoProps) {
  return showWordmark ? (
    <LogoWordmark size={size} className={className} />
  ) : (
    <LogoIcon size={size} />
  );
}
