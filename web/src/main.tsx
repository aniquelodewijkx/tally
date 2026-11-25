import "@fontsource-variable/inter";
import "./styles.css";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { needsSignIn } from "./api";
import { router } from "./router";
import { AuthGate } from "./screens/SignIn";
import { ToastProvider } from "./ui/toast";

// A call refused for want of a session (it ran out, or the passkey file was deleted on the server)
// rechecks the sign-in state, which brings up the sign-in screen.
const recheckSignIn = (e: unknown) => {
  if (needsSignIn(e)) void queryClient.invalidateQueries({ queryKey: ["auth"] });
};
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: recheckSignIn }),
  mutationCache: new MutationCache({ onError: recheckSignIn }),
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (n, e) => !needsSignIn(e) && n < 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
