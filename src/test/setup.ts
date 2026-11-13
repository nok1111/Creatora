import { vi } from "vitest";

// Mock Tauri IPC in jsdom — commands are not available outside the webview.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (name: string) => {
    if (name === "get_settings") return {};
    if (name === "app_info")
      return {
        name: "Creatora",
        version: "0.1.0",
        dataDir: "C:/test",
        ffmpegVersion: null,
      };
    return null;
  }),
}));
