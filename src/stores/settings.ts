import { create } from "zustand";
import i18n, { isLanguageCode, type LanguageCode } from "@/i18n";
import { api, AppError } from "@/lib/ipc";

export type Theme = "dark" | "light";

interface SettingsState {
  hydrated: boolean;
  theme: Theme;
  language: LanguageCode;
  autosaveIntervalSec: number;
  hydrate: () => Promise<void>;
  setTheme: (theme: Theme) => void;
  setLanguage: (lang: LanguageCode) => void;
  setAutosaveInterval: (sec: number) => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function persist(key: string, value: string) {
  // Fire-and-forget; failures are logged, not fatal.
  api.setSetting(key, value).catch((e: AppError) => {
    console.error(`[settings] failed to persist ${key}:`, e);
  });
}

export const useSettings = create<SettingsState>((set, get) => ({
  hydrated: false,
  theme: "dark",
  language: "en",
  autosaveIntervalSec: 30,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const s = await api.getSettings();
      const theme: Theme = s["appearance.theme"] === "light" ? "light" : "dark";
      const language: LanguageCode = isLanguageCode(s["app.language"])
        ? s["app.language"]
        : "en";
      const interval = Number.parseInt(s["project.autosaveIntervalSec"] ?? "", 10);
      set({
        hydrated: true,
        theme,
        language,
        autosaveIntervalSec:
          Number.isFinite(interval) && interval >= 5 ? interval : 30,
      });
      applyTheme(theme);
      void i18n.changeLanguage(language);
    } catch (e) {
      console.error("[settings] hydrate failed:", e);
      set({ hydrated: true });
      applyTheme(get().theme);
    }
  },

  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
    persist("appearance.theme", theme);
  },

  setLanguage: (language) => {
    set({ language });
    void i18n.changeLanguage(language);
    persist("app.language", language);
  },

  setAutosaveInterval: (sec) => {
    const clamped = Math.max(5, Math.min(600, Math.round(sec)));
    set({ autosaveIntervalSec: clamped });
    persist("project.autosaveIntervalSec", String(clamped));
  },
}));
