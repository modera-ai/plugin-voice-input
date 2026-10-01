import { expect, it, vi } from "vitest";
import { activate } from "../src/index";
import { SpeechBackend, type InstallProgress } from "../src/backend";

it("publishes preparation progress, retains a bounded error, and clears it on retry", async () => {
  let report: ((progress: InstallProgress) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let task: Promise<void> | undefined;
  const install = vi.spyOn(SpeechBackend.prototype, "install").mockImplementation(async (_python, _signal, _source, update) => {
    report = update;
    await new Promise<void>((_resolve, reject) => { fail = reject; });
  });
  const ready = vi.spyOn(SpeechBackend.prototype, "ready").mockResolvedValue(false);
  const signal = new AbortController().signal;
  const invalidateUi = vi.fn();
  const host = {
    storagePath: "unused", signal, invalidateUi,
    config: { read: async () => ({ values: {} }) },
    runBackground: (_context: unknown, run: (signal: AbortSignal) => Promise<void>) => { task = run(signal); },
  } as unknown as Parameters<typeof activate>[0];
  try {
    const contributions = await activate(host);
    const ui = contributions!.ui![0]!;
    const context = { projectId: "p", sessionId: "", runId: "ui", signal };
    const request = { projectId: "p", sessionId: "", id: ui.id, locale: "zh-CN" };
    await ui.act!({ id: "install" }, context, request);
    report!({ stage: "download", file: "model.int8.onnx", completed: 42, total: 100 });
    expect(await ui.render(request, context)).toMatchObject({ live: true, audioInput: { preparing: true, progress: { label: "下载语音模型", completed: 42, total: 100 } } });
    fail!(new Error("fetch failed", { cause: { code: "ETIMEDOUT" } }));
    await task;
    expect(await ui.render(request, context)).toMatchObject({ live: false, audioInput: { preparing: false, error: "fetch failed (ETIMEDOUT)" } });
    install.mockImplementation(async () => { ready.mockResolvedValue(true); });
    await ui.act!({ id: "install" }, context, request);
    await task;
    expect(await ui.render(request, context)).toMatchObject({ audioInput: { ready: true, preparing: false, error: "" } });
    expect(invalidateUi).toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); }
});
