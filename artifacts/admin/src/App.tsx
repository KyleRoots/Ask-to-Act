import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { getToken } from "@/lib/api";
import Login from "@/pages/Login";
import FirmsList from "@/pages/FirmsList";
import FirmDetail from "@/pages/FirmDetail";
import { useEffect } from "react";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function AuthGuard({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    if (!getToken()) navigate("/login");
  }, [navigate]);
  return getToken() ? <>{children}</> : null;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/firms/:id">
        {(params: { id: string }) => (
          <AuthGuard>
            <FirmDetail firmId={params.id} />
          </AuthGuard>
        )}
      </Route>
      <Route path="/firms">
        <AuthGuard>
          <FirmsList />
        </AuthGuard>
      </Route>
      <Route>
        <AuthGuard>
          <FirmsList />
        </AuthGuard>
      </Route>
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppRoutes />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
