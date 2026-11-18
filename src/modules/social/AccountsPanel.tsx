import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { api } from "@/lib/ipc";
import { useSocial } from "@/stores/social";
import {
  OAUTH_REDIRECT_URIS,
  PLATFORM_LABEL,
  SOCIAL_PLATFORMS,
  type SocialAccount,
  type SocialPlatform,
} from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { reportError } from "@/lib/errors";
import { PlatformIcon } from "./PlatformIcon";

const accountName = (a: SocialAccount) => a.displayName ?? a.platformUserId;

/**
 * Connected Accounts — honest capability display + OAuth client config.
 * The user brings their OWN developer-app credentials; nothing is baked
 * into the app. client_id → settings; client_secret → OS vault.
 */
export function AccountsPanel() {
  const { t, i18n } = useTranslation();
  const { accounts, capabilities, oauthClients, refreshAccounts } = useSocial();
  const [cfg, setCfg] = useState<Record<string, { id: string; secret: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<SocialAccount | null>(null);

  const connect = async (p: SocialPlatform) => {
    const platform = PLATFORM_LABEL[p];
    const cap = capabilities.find((c) => c.platform === p);
    if (!oauthClients[p] && !cap?.officialClient) {
      toast.error(t("social.acct_needClient", { platform }));
      return;
    }
    const clientId = cfg[p]?.id ?? "";
    setBusy(p);
    try {
      // clientId arg is required but real value lives in settings —
      // pass the saved one: fetch it again from settings.
      const settings = await api.getSettings();
      const saved = settings[`oauth_client_id.${p}`] ?? clientId;
      const start = await api.socialOauthBegin(p, saved);
      toast.message(
        t("social.acct_browserOpened", { platform, uri: start.redirectUri }),
      );
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const saveClient = async (p: SocialPlatform) => {
    const c = cfg[p];
    if (!c?.id?.trim()) {
      toast.error(t("social.acct_clientIdRequired"));
      return;
    }
    try {
      await api.saveOauthClient(p, c.id.trim(), c.secret?.trim() || undefined);
      toast.success(t("social.acct_clientSaved", { platform: PLATFORM_LABEL[p] }));
      void refreshAccounts();
    } catch (e) {
      reportError(e);
    }
  };

  const disconnect = async () => {
    const a = disconnecting;
    if (!a) return;
    setDisconnecting(null);
    try {
      await api.disconnectSocialAccount(a.id);
      toast.success(t("social.acct_disconnected"));
      void refreshAccounts();
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="grid flex-1 content-start gap-4 overflow-y-auto p-5 md:grid-cols-2">
      {SOCIAL_PLATFORMS.map((p) => {
        const cap = capabilities.find((c) => c.platform === p);
        // Revoked rows are kept only for audit history; expired/error ones
        // stay visible so the user can reconnect them.
        const accts = accounts.filter(
          (a) => a.platform === p && a.status !== "revoked",
        );
        const c = cfg[p] ?? { id: "", secret: "" };
        return (
          <div
            key={p}
            className="space-y-3 self-start rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <PlatformIcon platform={p} className="size-4" />
                {PLATFORM_LABEL[p]}
              </h3>
              <div className="flex gap-1">
                {cap?.officialClient && (
                  <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
                    {t("social.acct_officialApp")}
                  </span>
                )}
                {cap?.publish ? (
                  <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] text-success">
                    {t("social.acct_publish")}
                  </span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t("social.acct_exportOnly")}
                  </span>
                )}
                {cap?.requiresAppReview && (
                  <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                    {t("social.acct_appReview")}
                  </span>
                )}
              </div>
            </div>

            {cap && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                {t(`social.note_${p}`, { defaultValue: cap.statusNote })}
              </p>
            )}

            {/* connected accounts */}
            <div className="space-y-1">
              {accts.map((a) => {
                const healthy = a.status === "active";
                return (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs"
                  >
                    {healthy ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : (
                      <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{accountName(a)}</p>
                      {!healthy && (
                        <p className="text-[10px] text-warning">
                          {t(`social.acct_${a.status}`, { defaultValue: a.status })}
                        </p>
                      )}
                      {healthy && a.tokenExpiresAt && (
                        <p className="text-[10px] text-muted-foreground">
                          {t("social.acct_expires", {
                            date: new Date(a.tokenExpiresAt).toLocaleDateString(
                              i18n.language,
                            ),
                          })}
                        </p>
                      )}
                    </div>
                    {!healthy && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === p || !cap?.oauth}
                        onClick={() => void connect(p)}
                      >
                        <RefreshCw className="mr-1 size-3" />
                        {t("social.acct_reconnect")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t("social.acct_disconnect")}
                      aria-label={t("social.acct_disconnect")}
                      onClick={() => setDisconnecting(a)}
                    >
                      <Unplug className="size-3" />
                    </Button>
                  </div>
                );
              })}
              {accts.length === 0 && (
                <p className="text-[10px] italic text-muted-foreground">
                  {t("social.acct_none")}
                </p>
              )}
            </div>

            {/* oauth client config */}
            <details className="text-xs">
              <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                <KeyRound className="size-3" />{" "}
                {cap?.officialClient
                  ? t("social.acct_devCredsOptional")
                  : t("social.acct_devCreds")}{" "}
                {oauthClients[p] && (
                  <span className="text-success">{t("social.acct_configured")}</span>
                )}
              </summary>
              <div className="mt-2 space-y-1.5">
                <input
                  value={c.id}
                  onChange={(e) =>
                    setCfg({ ...cfg, [p]: { ...c, id: e.target.value } })
                  }
                  placeholder={t("social.acct_clientIdPh")}
                  className="h-7 w-full rounded border border-input bg-background px-2"
                />
                <input
                  value={c.secret}
                  onChange={(e) =>
                    setCfg({ ...cfg, [p]: { ...c, secret: e.target.value } })
                  }
                  type="password"
                  placeholder={t("social.acct_secretPh")}
                  className="h-7 w-full rounded border border-input bg-background px-2"
                />
                <Button size="sm" variant="secondary" onClick={() => void saveClient(p)}>
                  {t("social.acct_saveCreds")}
                </Button>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {t("social.acct_credsHelp")}
                </p>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  {t("social.acct_redirectUris")}
                </p>
                {OAUTH_REDIRECT_URIS.map((uri) => (
                  <button
                    key={uri}
                    type="button"
                    title={t("social.acct_copyUri")}
                    className="flex w-full items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-left font-mono text-[10px] text-muted-foreground hover:bg-accent/40"
                    onClick={() => {
                      void navigator.clipboard.writeText(uri);
                      toast.success(t("common.copied"));
                    }}
                  >
                    <span className="truncate">{uri}</span>
                    <Copy className="ml-auto size-2.5 shrink-0" />
                  </button>
                ))}
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
              {t("social.acct_connect", { platform: PLATFORM_LABEL[p] })}
            </Button>
          </div>
        );
      })}

      <AlertDialog
        open={!!disconnecting}
        onOpenChange={(v) => !v && setDisconnecting(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("social.acct_disconnectTitle", {
              name: disconnecting ? accountName(disconnecting) : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("social.acct_disconnectDesc")}
          </AlertDialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialogCancel onClick={() => setDisconnecting(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void disconnect()}>
              {t("social.acct_disconnectBtn")}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
