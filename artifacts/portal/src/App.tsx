import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/Home";
import Dashboard from "@/pages/Dashboard";
import Support from "@/pages/Support";
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

function SignInPage() {
  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center px-4 py-10"
      style={{ background: "hsl(220 50% 4%)" }}
    >
      <div className="pointer-events-none fixed inset-0" aria-hidden>
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full opacity-15"
          style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 70%)" }} />
      </div>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center px-4 py-10"
      style={{ background: "hsl(220 50% 4%)" }}
    >
      <div className="pointer-events-none fixed inset-0" aria-hidden>
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full opacity-15"
          style={{ background: "radial-gradient(circle, #4F46E5 0%, transparent 70%)" }} />
      </div>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
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
