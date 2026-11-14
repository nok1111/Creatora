import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen, Package } from "lucide-react";
import { api } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";

export function PacketsPanel() {
  const { t: tr } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Targets with an export are packet-able — reuse dashboard's post list
  // but also cover pre-publish targets via the posts list.
  const posts = useQuery({
    queryKey: ["social-posts-packets"],
    queryFn: () => api.listSocialPosts({}),
  });
  const packets = useQuery({
    queryKey: ["publish-packets"],
    queryFn: () => api.listPublishPackets(),
  });

  const targets = useMemo(() => {
    const out: { id: string; title: string; platform: string; hasExport: boolean; status: string }[] = [];
    for (const p of posts.data ?? []) {
      for (const t of p.targets ?? []) {
        out.push({
          id: t.id,
          title: t.title ?? p.title,
          platform: t.platform,
          hasExport: !!t.exportAssetId,
          status: t.status,
        });
      }
    }
    return out;
  }, [posts.data]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const exportPackets = async () => {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    setBusy(true);
    try {
      const r = await api.exportPublishPackets([...selected], dir);
      toast.success(`${r.exported.length} packets exported`);
      if (r.errors.length) toast.error(`${r.errors.length} failed — see console`);
      console.warn("packet errors", r.errors);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["publish-packets"] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-4 space-y-2">
        <div className="text-sm font-medium">{tr("ana.publishPackets")}</div>
        <p className="text-xs text-muted-foreground">
          Self-contained folder per target: video + thumbnail + metadata.txt +
          publication.json. For platforms without API publishing — everything
          you need to post manually. Files are hardlinked, not duplicated.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium">{tr("ana.targetsWithExports")}</span>
            <Button
              size="sm"
              disabled={selected.size === 0 || busy}
              onClick={() => void exportPackets()}
            >
              <Package size={13} className="mr-1" />
              Export {selected.size || ""} packets
            </Button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {targets.map((t) => (
              <label
                key={t.id}
                className="flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  disabled={!t.hasExport}
                  checked={selected.has(t.id)}
                  onChange={() => toggle(t.id)}
                />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto capitalize text-muted-foreground">
                  {t.platform}
                </span>
                {!t.hasExport && (
                  <span className="text-[10px] text-warning">{tr("ana.noExport")}</span>
                )}
              </label>
            ))}
            {targets.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                {tr("ana.noTargets")}
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-medium">
            Exported packets ({packets.data?.length ?? 0})
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {(packets.data ?? []).map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px]">{p.dirPath}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {p.files.join(" · ")} · {p.createdAt}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void api.revealPath(p.dirPath)}
                >
                  <FolderOpen size={13} />
                </Button>
              </div>
            ))}
            {(packets.data ?? []).length === 0 && (
              <div className="px-3 py-6 text-xs text-muted-foreground">
                No packets yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
