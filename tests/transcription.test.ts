import { expect, it, vi, afterEach } from "vitest";
import { activate } from "../src/index";
import { SpeechBackend } from "../src/backend";
import { cleanTranscript, polishLocally } from "../src/text-polish";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const signal = new AbortController().signal;
const context = { projectId: "p", sessionId: "s", runId: "audio", signal };
async function plugin(values: Record<string, unknown> = {}) {
  return (await activate({
    storagePath: "unused",
    signal,
    config: { read: async () => ({ values }) },
  } as unknown as Parameters<typeof activate>[0]))!;
}
it("defaults to final-only recognition and cheap local cleanup", async () => {
  vi.spyOn(SpeechBackend.prototype, "ready").mockResolvedValue(true);
  const transcribe = vi
    .spyOn(SpeechBackend.prototype, "transcribe")
    .mockResolvedValue("你好 世界");
  const contributions = await plugin();
  expect(
    await contributions.ui![0]!.render(
      { id: "modera.voice-input.microphone", sessionId: "s", locale: "zh-CN" },
      context,
    ),
  ).toMatchObject({ audioInput: { realtime: false, optimize: true } });
  const execute = contributions.composer![0]!.execute!;
  await expect(
    execute(
      {
        locale: "zh",
        query: "",
        audio: { mimeType: "audio/wav", base64: "fixture" },
      },
      context,
    ),
  ).resolves.toEqual([{ type: "insertText", text: "你好 世界" }]);
  expect(transcribe).toHaveBeenCalledWith(
    "fixture",
    "auto",
    2,
    expect.any(AbortSignal),
    "sensevoice",
  );
  await expect(
    execute({ locale: "zh", query: "你好 世界", audioTask: "polish" }, context),
  ).resolves.toEqual([{ type: "insertText", text: "你好世界" }]);
});
it("uses project model settings, bounds CPU threads, and routes ordered live chunks", async () => {
  const transcribe = vi
    .spyOn(SpeechBackend.prototype, "transcribe")
    .mockResolvedValue("最终");
  const preview = vi
    .spyOn(SpeechBackend.prototype, "preview")
    .mockResolvedValue("临时文字");
  const close = vi
    .spyOn(SpeechBackend.prototype, "closeStream")
    .mockImplementation(() => {});
  const execute = (
    await plugin({
      realtime: true,
      streamingModel: "zipformer-bilingual",
      recognitionModel: "zipformer-small",
      threads: 200,
    })
  ).composer![0]!.execute!;
  const id = "b455b609-dc0e-4bde-8ed2-f3e3a2f7b317";
  await expect(
    execute(
      {
        locale: "zh",
        query: "",
        audio: { mimeType: "audio/wav", base64: "chunk" },
        audioSession: { id, operation: "chunk", sequence: 0 },
      },
      context,
    ),
  ).resolves.toEqual([{ type: "insertText", text: "临时文字" }]);
  expect(preview).toHaveBeenCalledWith(
    JSON.stringify(["p", "s", id]),
    0,
    "chunk",
    "zipformer-bilingual",
    8,
    expect.any(AbortSignal),
    expect.any(AbortSignal),
  );
  await execute(
    { locale: "zh", query: "", audioSession: { id, operation: "close" } },
    context,
  );
  expect(close).toHaveBeenCalledWith(JSON.stringify(["p", "s", id]));
  await execute(
    {
      locale: "zh",
      query: "",
      audio: { mimeType: "audio/wav", base64: "all" },
    },
    context,
  );
  expect(transcribe).toHaveBeenCalledWith(
    "all",
    "auto",
    8,
    expect.any(AbortSignal),
    "zipformer-small",
  );
});
it("rejects live chunks when realtime is disabled", async () => {
  const execute = (await plugin()).composer![0]!.execute!;
  await expect(
    execute(
      {
        locale: "en",
        query: "",
        audio: { mimeType: "audio/wav", base64: "x" },
        audioSession: { id: "x", operation: "chunk", sequence: 0 },
      },
      context,
    ),
  ).rejects.toThrow("unavailable");
});
it("cleans spacing without deleting deliberate repetition, negation, names or numbers", () => {
  expect(
    cleanTranscript(
      "<|zh|> 我 不 要 取消， 取消 取消！版本 v1.2  价格 100 元。 ",
    ),
  ).toBe("我不要取消，取消取消！版本 v1.2 价格 100 元。");
});
it("uses only an installed local model, unloads it, and treats transcripts as data", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ models: [{ name: "local-editor:latest" }] }),
    )
    .mockResolvedValueOnce(
      Response.json({ model_info: { "general.architecture": "qwen" } }),
    )
    .mockResolvedValueOnce(
      Response.json({ done: true, message: { content: "整理后的文字。" } }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    polishLocally("整理后的文字", "local-editor", signal),
  ).resolves.toBe("整理后的文字。");
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "http://127.0.0.1:11434/api/tags",
    "http://127.0.0.1:11434/api/show",
    "http://127.0.0.1:11434/api/chat",
  ]);
  const request = JSON.parse(fetch.mock.calls[2]![1].body);
  expect(request).toMatchObject({
    stream: false,
    keep_alive: 0,
    messages: [{ role: "system" }, { role: "user", content: "整理后的文字" }],
  });
});
it("rejects cloud or missing models before generation", async () => {
  const fetch = vi.fn().mockImplementation(async () =>
    Response.json({
      models: [{ name: "remote", remote_host: "https://example.com" }],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(polishLocally("文字", "model:cloud", signal)).rejects.toThrow(
    "cloud",
  );
  expect(fetch).not.toHaveBeenCalled();
  await expect(polishLocally("文字", "missing", signal)).rejects.toThrow(
    "installed locally",
  );
  await expect(polishLocally("文字", "remote", signal)).rejects.toThrow(
    "installed locally",
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
