import { describe, expect, it, vi } from "vitest";
import { autosave } from "@/services/autosave";

describe("autosave service", () => {
  it("saves only dirty sources on tick", async () => {
    const dirty = { saved: 0 };
    const clean = { saved: 0 };

    const off1 = autosave.register({
      id: "dirty",
      isDirty: () => true,
      save: async () => {
        dirty.saved++;
      },
    });
    const off2 = autosave.register({
      id: "clean",
      isDirty: () => false,
      save: async () => {
        clean.saved++;
      },
    });

    await autosave.tick();
    expect(dirty.saved).toBe(1);
    expect(clean.saved).toBe(0);
    off1();
    off2();
  });

  it("reports save failures via error handler without stopping others", async () => {
    const ok = { saved: 0 };
    const errors: string[] = [];
    autosave.setErrorHandler((id) => errors.push(id));

    const off1 = autosave.register({
      id: "fails",
      isDirty: () => true,
      save: async () => {
        throw new Error("disk full");
      },
    });
    const off2 = autosave.register({
      id: "ok",
      isDirty: () => true,
      save: async () => {
        ok.saved++;
      },
    });

    await autosave.tick();
    expect(errors).toEqual(["fails"]);
    expect(ok.saved).toBe(1);
    off1();
    off2();
  });

  it("unregister removes the source", async () => {
    const save = vi.fn();
    const off = autosave.register({
      id: "temp",
      isDirty: () => true,
      save,
    });
    off();
    await autosave.tick();
    expect(save).not.toHaveBeenCalled();
  });
});
