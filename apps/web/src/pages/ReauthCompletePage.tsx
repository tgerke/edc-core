import { useEffect, useState } from "react";
import { Card } from "../components/ui.js";

/**
 * Landing page for the e-signature re-authentication popup. The OIDC
 * callback redirects here with the single-use grant in the URL fragment
 * (fragments never reach the server); we hand it to the opener and close.
 */
export function ReauthCompletePage() {
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const grant = params.get("grant");
    const error = params.get("error");
    // Strip the grant from the address bar/history immediately.
    window.history.replaceState(null, "", "/reauth-complete");
    if (!window.opener) {
      setFailed("This page only works as part of the signing flow.");
      return;
    }
    window.opener.postMessage(
      grant ? { type: "edc-reauth", grant } : { type: "edc-reauth", error: error ?? "unknown" },
      window.location.origin,
    );
    window.close();
    // Some browsers refuse window.close(); show a hint instead of a blank page.
    setFailed(null);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <Card className="max-w-sm p-6 text-center text-sm text-zinc-600">
        {failed ?? "Re-authentication complete. You can close this window."}
      </Card>
    </main>
  );
}
