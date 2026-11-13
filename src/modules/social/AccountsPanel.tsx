import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, Loader2, Plug, Unplug } from "lucide-react";
import { api } from "@/lib/ipc";
import { useSocial } from "@/stores/social";
import {
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";

/**
 * Connected Accounts — honest capability display + OAuth client config.
 * The user brings their OWN developer-app credentials; nothing is baked
 * into the app. client_id → settings; client_secret → OS vault.
 */
export function AccountsPanel() {
  const { accounts, capabilities, oauthClients, refreshAccounts } = useSocial();
  const [cfg, setCfg] = useState<Record<string, { id: string; secret: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const connect = async (p: SocialPlatform) => {
    const c = cfg[p];
    if (!oauthClients[p]) {
      toast.error(
        `Configure a ${PLATFORM_LABEL[p]} developer-app client id first (below). ` +
          `Create one in the ${PLATFORM_LABEL[p]} developer console — the app ships no credentials.`,
      );
      return;
    }
    const clientId = c?.id ?? "";
    setBusy(p);
    try {
      // clientId arg is required but real value lives in settings —
      // pass the saved one: fetch it again from settings.
      const settings = await api.getSettings();
      const saved = settings[`oauth_client_id.${p}`] ?? clientId;
      const start = await api.socialOauthBegin(p, saved);
      toast.message(
        `Browser opened for ${PLATFORM_LABEL[p]}. Redirect URI to whitelist: ${start.redirectUri}`,
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveClient = async (p: SocialPlatform) => {
    const c = cfg[p];
    if (!c?.id?.trim()) {
      toast.error("client id required");
      return;
    }
    await api.saveOauthClient(p, c.id.trim(), c.secret?.trim() || undefined);
    toast.success(`${PLATFORM_LABEL[p]} client saved (secret → OS vault)`);
    void refreshAccounts();
  };

  return (
    <div className="grid flex-1 gap-4 overflow-y-auto p-5 md:grid-cols-2">
      {SOCIAL_PLATFORMS.map((p) => {
        const cap = capabilities.find((c) => c.platform === p);
        const accts = accounts.filter(
          (a) => a.platform === p && a.status === "active",
        );
        const c = cfg[p] ?? { id: "", secret: "" };
        return (
          <div
            key={p}
            className="space-y-3 self-start rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{PLATFORM_LABEL[p]}</h3>
              <div className="flex gap-1">
                {cap?.publish ? (
                  <span className="rounded bg-green-500/15 px-1.5 py-0.5 text-[9px] text-green-400">
                    publish
                  </span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    export only
                  </span>
                )}
                {cap?.requiresAppReview && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] text-amber-400">
                    app review
                  </span>
                )}
              </div>
            </div>

            {cap && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                {cap.statusNote}
              </p>
            )}

            {/* connected accounts */}
            <div className="space-y-1">
              {accts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs"
                >
                  <CheckCircle2 className="size-3.5 text-green-400" />
                  <span className="flex-1 truncate">
                    {a.displayName ?? a.platformUserId}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Disconnect (deletes stored credentials)"
                    onClick={async () => {
                      await api.disconnectSocialAccount(a.id);
                      toast.success("Account disconnected");
                      void refreshAccounts();
                    }}
                  >
                    <Unplug className="size-3" />
                  </Button>
                </div>
              ))}
              {accts.length === 0 && (
                <p className="text-[10px] italic text-muted-foreground">
                  no account connected
                </p>
              )}
            </div>

            {/* oauth client config */}
            <details className="text-xs">
              <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                <KeyRound className="size-3" /> Developer app credentials{" "}
                {oauthClients[p] && (
                  <span className="text-green-400">(configured)</span>
                )}
              </summary>
              <div className="mt-2 space-y-1.5">
                <input
                  value={c.id}
                  onChange={(e) =>
                    setCfg({ ...cfg, [p]: { ...c, id: e.target.value } })
                  }
                  placeholder="Client ID / App ID"
                  className="h-7 w-full rounded border border-input bg-background px-2"
                />
                <input
                  value={c.secret}
                  onChange={(e) =>
                    setCfg({ ...cfg, [p]: { ...c, secret: e.target.value } })
                  }
                  type="password"
                  placeholder="Client secret (stored in OS vault)"
                  className="h-7 w-full rounded border border-input bg-background px-2"
                />
                <Button size="sm" variant="secondary" onClick={() => void saveClient(p)}>
                  Save credentials
                </Button>
                <p className="text-[9px] leading-snug text-muted-foreground">
                  Create a free developer app in the platform's console,
                  whitelist the loopback redirect URI shown on connect, and
                  paste the credentials here. The app never ships its own.
                </p>
              </div>
            </details>

            <Button
              size="sm"
              className="w-full"
              disabled={busy === p || !cap?.oauth}
              onClick={() => void connect(p)}
            >
              {busy === p ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <Plug className="mr-1 size-3.5" />
              )}
              Connect {PLATFORM_LABEL[p]}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
