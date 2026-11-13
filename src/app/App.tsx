import { useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MODULES } from "@/app/nav";
import { HomePage } from "@/modules/home/HomePage";
import { LibraryPage } from "@/modules/library/LibraryPage";
import { EditorPage } from "@/modules/editor/EditorPage";
import { SettingsPage } from "@/modules/settings/SettingsPage";
import { SocialPage } from "@/modules/social/SocialPage";
import { AnalyticsPage } from "@/modules/analytics/AnalyticsPage";
import { useSettings } from "@/stores/settings";
import { autosave } from "@/services/autosave";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function pageFor(key: string) {
  switch (key) {
    case "home":
      return <HomePage />;
    case "library":
      return <LibraryPage />;
    case "editor":
      return <EditorPage />;
    case "social":
      return <SocialPage />;
    case "analytics":
      return <AnalyticsPage />;
    case "settings":
      return <SettingsPage />;
    default:
      return null;
  }
}

export default function App() {
  const { hydrate, hydrated, autosaveIntervalSec, theme } = useSettings();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Autosave service lifecycle follows the configured interval.
  useEffect(() => {
    if (!hydrated) return;
    autosave.setIntervalMs(autosaveIntervalSec * 1000);
    autosave.start();
    return () => autosave.stop();
  }, [hydrated, autosaveIntervalSec]);

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ErrorBoundary>
          <Routes>
            <Route element={<AppShell />}>
              {MODULES.map((m) => (
                <Route
                  key={m.key}
                  path={m.path === "/" ? "/" : m.path}
                  index={m.path === "/"}
                  element={pageFor(m.key) ?? <ModulePlaceholder module={m} />}
                />
              ))}
            </Route>
          </Routes>
        </ErrorBoundary>
      </HashRouter>
      <Toaster
        theme={theme}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "bg-card border-border",
          },
        }}
      />
    </QueryClientProvider>
  );
}
