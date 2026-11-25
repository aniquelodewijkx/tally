import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { auth, errorMessage, passkeysAvailable } from "../api";
import { Icon, IconSprite } from "../ui/Icon";

export const useAuthState = () => useQuery({ queryKey: ["auth"], queryFn: auth.status, staleTime: Infinity, retry: false });

/** Shows the app only when the server doesn't need a passkey, or this browser is signed in. */
export function AuthGate({ children }: { children: ReactNode }) {
  const state = useAuthState();
  if (state.isPending) return null;
  if (state.data === "setup" || state.data === "signed-out") return <SignIn setup={state.data === "setup"} />;
  // "off", "signed-in", or the server can't be reached: the app shows its own error for that.
  return children;
}

function SignIn({ setup }: { setup: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = passkeysAvailable();

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await (setup ? auth.setUp() : auth.signIn());
      await qc.invalidateQueries();
    } catch (e) {
      setError(errorMessage(e));
      // Someone else may have set it up meanwhile, or the passkey file was deleted.
      await qc.invalidateQueries({ queryKey: ["auth"] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <IconSprite />
      <div className="signin-card">
        <span className="signin-icon"><Icon name="key" /></span>
        <h1>{setup ? "Set Up a Passkey" : "Sign In to Tally"}</h1>
        <p>
          {setup
            ? "Tally will only open with this passkey. Your password manager, such as iCloud Keychain, keeps it and syncs it to your other devices."
            : "Use the passkey you set Tally up with."}
        </p>
        {available ? (
          <button type="button" className="btn primary signin-btn" disabled={busy} onClick={go}>
            {setup ? "Create Passkey" : "Sign In with Passkey"}
          </button>
        ) : (
          <p className="error-text">Passkeys only work over https. Open Tally at its https address.</p>
        )}
        {error && <p className="error-text" role="alert">{error}</p>}
        {setup && <p className="signin-note">To start over later, delete the passkey file on the server.</p>}
      </div>
    </div>
  );
}
