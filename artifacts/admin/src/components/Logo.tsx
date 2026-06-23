interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}

export function LogoIcon({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="ata-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
        <linearGradient id="ata-grad-sm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      {/* Rounded square background */}
      <rect width="48" height="48" rx="12" fill="url(#ata-grad)" />
      {/* Speech bubble body */}
      <path
        d="M10 13C10 11.3 11.3 10 13 10H30C31.7 10 33 11.3 33 13V24C33 25.7 31.7 27 30 27H21L16 32V27H13C11.3 27 10 25.7 10 24V13Z"
        fill="white"
        opacity="0.92"
      />
      {/* Arrow pointing right */}
      <path
        d="M35 29L42 22M42 22L35 15M42 22H27"
        stroke="white"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoIcon size={size} />
      <span
        style={{ fontSize: size * 0.55, fontWeight: 700, letterSpacing: "-0.02em" }}
        className="text-white leading-none"
      >
        Ask<span style={{ color: "#06B6D4" }}>To</span>Act
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
