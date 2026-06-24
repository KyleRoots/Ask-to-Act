import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/Home";
import Dashboard from "@/pages/Dashboard";
import Support from "@/pages/Support";
import TeamUsage from "@/pages/TeamUsage";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

// REQUIRED — resolves the publishable key from the request hostname so the
// same build can serve multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (intentional), auto-populated in prod. Do NOT gate.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths; wouter's setLocation prepends the base — strip it.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  baseTheme: dark,
  cssLayerName: "clerk" as const,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    socialButtonsVariant: "blockButton" as const,
    socialButtonsPlacement: "top" as const,
  },
  variables: {
    colorPrimary: "#4F46E5",
    colorForeground: "#F8FAFC",
    colorMutedForeground: "#6B7A99",
    colorDanger: "#EF4444",
    colorBackground: "#0D1728",
    colorInput: "#111D30",
    colorInputForeground: "#F8FAFC",
    colorNeutral: "#1B2D47",
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
    borderRadius: "0.875rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "w-[440px] max-w-full overflow-hidden rounded-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-white font-extrabold",
    headerSubtitle: "text-[#6B7A99]",
    socialButtonsBlockButtonText: "text-white font-medium",
    socialButtonsBlockButton: "border border-[#1B2D47] bg-[#111D30] hover:bg-[#182540] transition-colors",
    formFieldLabel: "text-[#6B7A99] text-xs font-semibold uppercase tracking-wider",
    formFieldInput: "bg-[#111D30] border border-[#1B2D47] text-white rounded-xl",
    formButtonPrimary: "bg-gradient-to-r from-indigo-600 to-sky-500 shadow-lg font-bold",
    footerActionLink: "text-[#818CF8] hover:text-[#38BDF8] font-medium",
    footerActionText: "text-[#3A4460]",
    footerAction: "bg-[#0A111E] border-t border-[#1B2D47]",
    dividerText: "text-[#3A4460]",
    dividerLine: "bg-[#1B2D47]",
    identityPreviewEditButton: "text-[#818CF8]",
    formFieldSuccessText: "text-emerald-400",
    alertText: "text-white",
    alert: "bg-[#0A111E] border border-[#1B2D47]",
    otpCodeFieldInput: "bg-[#111D30] border border-[#1B2D47] text-white",
    logoBox: "flex justify-center py-2",
    logoImage: "h-12 w-12",
    main: "bg-[#0D1728]",
    formFieldRow: "",
  },
};

const AUTH_FEATURES = [
  { icon: "🤖", text: "Ask ChatGPT, Claude, or Gemini to search and update Bullhorn" },
  { icon: "🔒", text: "Every action respects each recruiter's existing permissions" },
  { icon: "📊", text: "See team usage insights across all AI tools" },
];

function AuthBrandPanel({ heading, sub }: { heading: string; sub: string }) {
  return (
    <div
      className="hidden lg:flex flex-col justify-between p-12 relative overflow-hidden"
      style={{
        background: "linear-gradient(155deg, #0f0c29 0%, #1a1060 50%, #0d1728 100%)",
        minHeight: "100dvh",
        width: "48%",
      }}
    >
      {/* Ambient glows */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -top-20 -left-20 w-96 h-96 rounded-full opacity-20"
          style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 65%)" }} />
        <div className="absolute bottom-0 right-0 w-72 h-72 rounded-full opacity-10"
          style={{ background: "radial-gradient(circle, #0EA5E9 0%, transparent 65%)" }} />
      </div>

      {/* Logo */}
      <div className="relative flex items-center gap-3">
        <svg width="36" height="36" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="apg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#4338CA" />
              <stop offset="55%" stopColor="#4F46E5" />
              <stop offset="100%" stopColor="#0EA5E9" />
            </linearGradient>
          </defs>
          <rect width="48" height="48" rx="13" fill="url(#apg)" />
          <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
          <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
          <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-lg font-extrabold text-white" style={{ letterSpacing: "-0.025em" }}>
          Ask<span style={{ color: "#38BDF8" }}>To</span>Act
        </span>
      </div>

      {/* Headline + features */}
      <div className="relative">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-6"
          style={{ background: "rgba(79,70,229,.18)", border: "1px solid rgba(79,70,229,.3)", color: "#818CF8" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Customer Portal
        </div>
        <h2 className="text-3xl font-extrabold text-white mb-3" style={{ letterSpacing: "-0.03em", lineHeight: 1.25 }}>
          {heading}
        </h2>
        <p className="text-sm mb-10" style={{ color: "#6B7A99", lineHeight: 1.75 }}>{sub}</p>
        <div className="flex flex-col gap-4">
          {AUTH_FEATURES.map((f) => (
            <div key={f.text} className="flex items-start gap-4">
              <div className="flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                style={{ background: "rgba(79,70,229,.15)", border: "1px solid rgba(79,70,229,.25)" }}>
                {f.icon}
              </div>
              <p className="text-sm leading-relaxed pt-1.5" style={{ color: "#94A3B8" }}>{f.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer note */}
      <p className="relative text-xs" style={{ color: "#3A4460" }}>
        © {new Date().getFullYear()} AskToAct · Secure · SOC2-ready
      </p>
    </div>
  );
}

function AuthLayout({ children, heading, sub }: { children: ReactNode; heading: string; sub: string }) {
  return (
    <div className="flex min-h-[100dvh]" style={{ background: "hsl(220 50% 4%)" }}>
      <AuthBrandPanel heading={heading} sub={sub} />
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 relative">
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute top-0 right-0 w-[420px] h-[420px] rounded-full opacity-[0.07]"
            style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 70%)" }} />
          <div className="absolute bottom-0 left-0 w-64 h-64 rounded-full opacity-[0.05]"
            style={{ background: "radial-gradient(circle, #0EA5E9 0%, transparent 70%)" }} />
        </div>
        {/* Mobile-only logo */}
        <div className="lg:hidden flex items-center gap-2 mb-8">
          <svg width="30" height="30" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="mlg" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#4338CA" />
                <stop offset="100%" stopColor="#0EA5E9" />
              </linearGradient>
            </defs>
            <rect width="48" height="48" rx="13" fill="url(#mlg)" />
            <path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fillOpacity="0.97" />
            <line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" />
            <polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-base font-extrabold text-white" style={{ letterSpacing: "-0.025em" }}>
            Ask<span style={{ color: "#38BDF8" }}>To</span>Act
          </span>
        </div>
        <div className="relative w-full max-w-[420px]">{children}</div>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <AuthLayout
      heading={"Your team's AI\ncommand centre"}
      sub="Sign in to manage your team's Bullhorn AI access, view usage insights, and keep everything running smoothly."
    >
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </AuthLayout>
  );
}

function SignUpPage() {
  return (
    <AuthLayout
      heading="Get your team connected to AI"
      sub="Set up your AskToAct workspace and give your recruiters AI-powered access to Bullhorn in minutes."
    >
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </AuthLayout>
  );
}

// Invalidates React Query cache on auth state change
function ClerkCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    return addListener(({ user }) => {
      const uid = user?.id ?? null;
      if (prevRef.current !== undefined && prevRef.current !== uid) {
        qc.clear();
      }
      prevRef.current = uid;
    });
  }, [addListener, qc]);

  return null;
}

// Home: signed-in → redirect to dashboard; signed-out → landing page
function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

// Dashboard: signed-in → show dashboard; signed-out → redirect to home
function DashboardRoute() {
  return (
    <>
      <Show when="signed-in">
        <Dashboard />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to your team portal",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Get your team connected to AI",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/dashboard" component={DashboardRoute} />
          <Route path="/team-usage" component={() => (
            <>
              <Show when="signed-in"><TeamUsage /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </>
          )} />
          <Route path="/support" component={() => (
            <>
              <Show when="signed-in"><Support /></Show>
              <Show when="signed-out"><Redirect to="/" /></Show>
            </>
          )} />
          <Route component={NotFound} />
        </Switch>
        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
