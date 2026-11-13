import { create } from "zustand";
import { api } from "@/lib/ipc";
import type {
  PlatformCapability,
  SocialAccount,
  SocialPost,
  SocialPlatform,
} from "@/lib/social-types";

interface SocialState {
  posts: SocialPost[];
  accounts: SocialAccount[];
  capabilities: PlatformCapability[];
  oauthClients: Record<string, boolean>;
  loaded: boolean;
  /** Status filter on the dashboard; "" = all. */
  statusFilter: string;
  platformFilter: SocialPlatform | "";
  search: string;
  setStatusFilter: (s: string) => void;
  setPlatformFilter: (s: SocialPlatform | "") => void;
  setSearch: (s: string) => void;
  refreshPosts: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  refreshAll: () => Promise<void>;
  capabilityOf: (p: SocialPlatform) => PlatformCapability | undefined;
}

export const useSocial = create<SocialState>((set, get) => ({
  posts: [],
  accounts: [],
  capabilities: [],
  oauthClients: {},
  loaded: false,
  statusFilter: "",
  platformFilter: "",
  search: "",
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setPlatformFilter: (platformFilter) => set({ platformFilter }),
  setSearch: (search) => set({ search }),

  refreshPosts: async () => {
    const { statusFilter, platformFilter, search } = get();
    const posts = await api.listSocialPosts({
      status: statusFilter || undefined,
      platform: platformFilter || undefined,
      query: search || undefined,
    });
    set({ posts });
  },
  refreshAccounts: async () => {
    const [accounts, oauthClients] = await Promise.all([
      api.listSocialAccounts(),
      api.oauthClientStatus(),
    ]);
    set({ accounts, oauthClients });
  },
  refreshCapabilities: async () => {
    const capabilities = await api.platformCapabilities();
    set({ capabilities });
  },
  refreshAll: async () => {
    await Promise.all([
      get().refreshPosts(),
      get().refreshAccounts(),
      get().refreshCapabilities(),
    ]);
    set({ loaded: true });
  },
  capabilityOf: (p) => get().capabilities.find((c) => c.platform === p),
}));
