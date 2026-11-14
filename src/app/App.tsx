import { Suspense, lazy, useEffect } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { ModulePlaceholder } from "@/components/ModulePlaceholder";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MODULES } from "@/app/nav";
import { HomePage } from "@/modules/home/HomePage";

// Heavy modules are lazy — each ships its own chunk, loaded on first visit.
const LibraryPage = lazy(() =>
  import("@/modules/library/LibraryPage").then((m) => ({ default: m.LibraryPage })),
);
const EditorPage = lazy(() =>
  import("@/modules/editor/EditorPage").then((m) => ({ default: m.EditorPage })),
);
const SettingsPage = lazy(() =>
  import("@/modules/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const SocialPage = lazy(() =>
  import("@/modules/social/SocialPage").then((m) => ({ default: m.SocialPage })),
);
const DesignPreview = lazy(() =>
  import("@/modules/preview/DesignPreview").then((m) => ({ default: m.DesignPreview })),
);
const ExportsPage = lazy(() =>
  import("@/modules/exports/ExportsPage").then((m) => ({ default: m.ExportsPage })),
);
const AnalyticsPage = lazy(() =>
  import("@/modules/analytics/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })),
);

function ModuleLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading module…
    </div>
  );
}
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
    case "exports":
      return <ExportsPage />;
    case "analytics":
      return <AnalyticsPage />;
    case "settings":
      return <SettingsPage />;
    // Scaffolded routes → deep-link into the module hosting the feature.
    case "formats":
    case "export":
      return <Navigate to="/editor" replace />;
    case "subtitles":
      return <Navigate to="/editor?tab=subtitles" replace />;
    case "audio":
      return <Navigate to="/editor" replace />;
    case "graphics":
    case "brand":
      return <Navigate to="/editor?left=graphics" replace />;
    case "planner":
      return <Navigate to="/social?tab=calendar" replace />;
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
            <Route
              path="/design-preview"
              element={
                <Suspense fallback={<ModuleLoading />}>
                  <DesignPreview />
                </Suspense>
              }
            />
            <Route element={<AppShell />}>
              {MODULES.map((m) => (
                <Route
                  key={m.key}
                  path={m.path === "/" ? "/" : m.path}
                  index={m.path === "/"}
                  element={
                    <Suspense fallback={<ModuleLoading />}>
                      {pageFor(m.key) ?? <ModulePlaceholder module={m} />}
                    </Suspense>
                  }
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
