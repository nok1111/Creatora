import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, Save, Trash2 } from "lucide-react";
import { api } from "@/lib/ipc";
import { extractHashtags } from "@/lib/social-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Caption Studio — shared title/caption/hashtag editing with counters,
 * dedupe, history suggestions and saved templates. Fully local.
 */
export function CaptionStudio({
  title,
  onTitle,
  caption,
  onCaption,
  hashtags,
  onHashtags,
}: {
  title: string;
  onTitle: (v: string) => void;
  caption: string;
  onCaption: (v: string) => void;
  hashtags: string[];
  onHashtags: (v: string[]) => void;
}) {
  const [tagInput, setTagInput] = useState("");
  const { data: templates, refetch: refetchTemplates } = useQuery({
    queryKey: ["caption-templates"],
    queryFn: () => api.listCaptionTemplates(),
  });
  const { data: history } = useQuery({
    queryKey: ["hashtag-history"],
    queryFn: () => api.listHashtagHistory(30),
  });

  const inText = useMemo(() => extractHashtags(caption), [caption]);
  const allTags = useMemo(
    () => [...hashtags, ...inText.filter((t) => !hashtags.includes(t))],
    [hashtags, inText],
  );
  const suggestions = useMemo(
    () =>
      (history ?? []).filter(
        (h) => !allTags.some((t) => t.toLowerCase() === h.toLowerCase()),
      ),
    [history, allTags],
  );

  const addTag = () => {
    const t = tagInput.trim().replace(/^#+/, "").split(/\s+/)[0];
    if (!t) return;
    if (!allTags.some((x) => x.toLowerCase() === t.toLowerCase())) {
      onHashtags([...hashtags, t]);
    }
    setTagInput("");
  };

  const saveTemplate = async () => {
    const name = prompt("Template name:");
    if (!name) return;
    await api.saveCaptionTemplate({ name, body: caption, hashtags });
    toast.success("Template saved");
    void refetchTemplates();
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            Title
          </label>
          <span
            className={cn(
              "text-[10px]",
              title.length > 100 ? "text-red-400" : "text-muted-foreground",
            )}
          >
            {title.length}/100
          </span>
        </div>
        <input
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          placeholder="Post title"
          className="h-8 w-full rounded border border-input bg-background px-2 text-sm"
        />
      </div>

      <div className="flex flex-1 flex-col space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            Caption
          </label>
          <span className="text-[10px] text-muted-foreground">
            {caption.length} chars · {inText.length} # in text
          </span>
        </div>
        <textarea
          value={caption}
          onChange={(e) => onCaption(e.target.value)}
          placeholder={"Caption…\n#hashtags inline work too"}
          className="min-h-28 w-full flex-1 resize-none rounded border border-input bg-background p-2 text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Hash className="size-3" /> Hashtags ({allTags.length})
          </label>
        </div>
        <div className="flex flex-wrap gap-1">
          {allTags.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
            >
              #{t}
              {!inText.includes(t) && (
                <button
                  onClick={() =>
                    onHashtags(hashtags.filter((h) => h !== t))
                  }
                  className="hover:text-red-400"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag()}
            placeholder="+ tag"
            className="h-5 w-16 rounded border border-dashed border-input bg-transparent px-1 text-[10px]"
          />
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <span className="text-[9px] text-muted-foreground">used before:</span>
            {suggestions.slice(0, 8).map((h) => (
              <button
                key={h}
                onClick={() => onHashtags([...hashtags, h])}
                className="rounded border border-border px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent"
              >
                #{h}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* templates */}
      <div className="space-y-1.5 border-t border-border pt-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            Templates
          </label>
          <Button size="sm" variant="ghost" onClick={() => void saveTemplate()}>
            <Save className="size-3" />
          </Button>
        </div>
        {(templates ?? []).map((tp) => (
          <div
            key={tp.id}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs"
          >
            <button
              className="flex-1 truncate text-left hover:text-primary"
              title={tp.body}
              onClick={() => {
                onCaption(tp.body);
                onHashtags(tp.hashtags);
              }}
            >
              {tp.name}
            </button>
            <button
              onClick={async () => {
                await api.deleteCaptionTemplate(tp.id);
                void refetchTemplates();
              }}
              className="text-muted-foreground hover:text-red-400"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
        {(templates ?? []).length === 0 && (
          <p className="text-[10px] italic text-muted-foreground">
            save the current caption as a reusable template
          </p>
        )}
      </div>

      {/* mini preview */}
      <div className="space-y-1 border-t border-border pt-2">
        <label className="text-xs font-medium text-muted-foreground">
          Preview
        </label>
        <div className="rounded border border-border bg-muted/30 p-2 text-xs">
          <p className="font-semibold">{title || "Post title"}</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {caption || "Caption…"}
          </p>
          {allTags.length > 0 && (
            <p className="mt-1 text-primary">
              {allTags.map((t) => `#${t}`).join(" ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
