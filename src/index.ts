import { join } from "node:path";
import type { PluginModule } from "@modera/plugin-sdk";
import {
  SpeechBackend,
  installationError,
  type InstallProgress,
} from "./backend";
import type { SpeechModel, StreamingModel } from "./streaming";
import { cleanTranscript, polishLocally } from "./text-polish";

export const activate: PluginModule["activate"] = async (host) => {
  const backend = new SpeechBackend(join(host.storagePath, "sensevoice"));
  let installing = false,
    recognizing = false,
    error = "";
  let progress: InstallProgress | undefined;
  const permissions = [
    "audio.record",
    "process.spawn",
    "network.fetch",
    "storage.read",
    "storage.write",
  ] as const;
  const settings = async (projectId?: string) => {
    const values = (await host.config?.read(projectId))?.values ?? {};
    const model: SpeechModel =
      values.recognitionModel === "zipformer-small" ||
      values.recognitionModel === "zipformer-bilingual"
        ? values.recognitionModel
        : "sensevoice";
    const streamingModel: StreamingModel =
      values.streamingModel === "zipformer-bilingual"
        ? "zipformer-bilingual"
        : "zipformer-small";
    return {
      values,
      model,
      streamingModel,
      realtime: values.realtime === true,
      optimize: values.textCleanup !== "none",
      cleanup: String(values.textCleanup ?? "basic"),
      threads: Math.max(
        1,
        Math.min(8, Math.floor(Number(values.threads) || 2)),
      ),
    };
  };
  host.signal.addEventListener("abort", () => backend.close(), { once: true });
  return {
    ui: [
      {
        id: "modera.voice-input.microphone",
        slot: "conversation.composer",
        requiredPermissions: permissions,
        audioInput: {
          contributionId: "modera.voice-input.transcribe",
          prepareAction: "install",
        },
        actions: ["install"],
        async render(request, context) {
          const config = await settings(context.projectId);
          const zh = request.locale.startsWith("zh");
          const label =
            progress?.stage === "environment"
              ? zh
                ? "创建语音环境"
                : "Creating speech environment"
              : progress?.stage === "dependencies"
                ? zh
                  ? "安装语音运行库"
                  : "Installing speech runtime"
                : progress?.stage === "verify"
                  ? zh
                    ? "验证语音环境"
                    : "Verifying speech environment"
                  : progress?.file === "tokens.txt"
                    ? zh
                      ? "下载词表"
                      : "Downloading vocabulary"
                    : zh
                      ? "下载语音模型"
                      : "Downloading speech model";
          return {
            title: zh ? "语音输入" : "Voice input",
            children: [],
            live: installing,
            audioInput: {
              ready:
                !installing &&
                (await backend.ready(config.model)) &&
                (!config.realtime ||
                  (await backend.ready(config.streamingModel))),
              preparing: installing,
              error,
              realtime: config.realtime,
              optimize: config.optimize,
              ...(progress
                ? {
                    progress: {
                      label,
                      ...(progress.completed === undefined
                        ? {}
                        : { completed: progress.completed }),
                      ...(progress.total === undefined
                        ? {}
                        : { total: progress.total }),
                    },
                  }
                : {}),
            },
          };
        },
        async act(action, context) {
          if (action.id !== "install") throw new Error("Unknown voice action");
          if (installing) return;
          if (!host.runBackground)
            throw new Error("Background installation unavailable");
          const config = await settings(context.projectId);
          installing = true;
          error = "";
          progress = { stage: "environment" };
          try {
            host.runBackground(
              { ...context, label: "Install local SenseVoice" },
              async (signal) => {
                try {
                  await backend.install(
                    String(config.values.pythonExecutable ?? "python"),
                    AbortSignal.any([
                      host.signal,
                      signal,
                      AbortSignal.timeout(20 * 60 * 1000),
                    ]),
                    String(config.values.modelSource ?? "huggingface.co"),
                    (next) => {
                      const stageChanged =
                        progress?.stage !== next.stage ||
                        progress?.file !== next.file;
                      progress = next;
                      if (stageChanged) host.invalidateUi?.();
                    },
                    [
                      config.model,
                      ...(config.realtime ? [config.streamingModel] : []),
                    ],
                  );
                } catch (cause) {
                  error = installationError(cause);
                } finally {
                  installing = false;
                  host.invalidateUi?.();
                }
              },
            );
          } catch (cause) {
            installing = false;
            error = installationError(cause);
            throw cause;
          }
          host.invalidateUi?.();
        },
      },
    ],
    composer: [
      {
        id: "modera.voice-input.transcribe",
        title: "Transcribe local audio",
        kind: "action",
        requiredPermissions: permissions,
        audioInput: { maxDurationSeconds: 120 },
        async execute(request, context) {
          const streamKey = request.audioSession
            ? JSON.stringify([
                context.projectId,
                context.sessionId,
                request.audioSession.id,
              ])
            : undefined;
          if (request.audioSession?.operation === "close") {
            backend.closeStream(streamKey!);
            return [];
          }
          const config = await settings(context.projectId);
          const lifetime = AbortSignal.any([
            host.signal,
            host.scopeSignal?.(context.projectId) ?? host.signal,
          ]);
          const signal = AbortSignal.any([context.signal, lifetime]);
          if (request.audioTask === "polish") {
            if (request.query.length > 16000)
              throw new Error("Transcript too long for cleanup");
            const text =
              config.cleanup === "ollama"
                ? await polishLocally(
                    request.query,
                    String(config.values.cleanupModel ?? ""),
                    signal,
                  )
                : config.cleanup === "none"
                  ? request.query
                  : cleanTranscript(request.query);
            return [{ type: "insertText", text }];
          }
          if (!request.audio) throw new Error("Recording required");
          if (request.audioSession?.operation === "chunk") {
            if (!config.realtime || installing)
              throw new Error("Live transcription is unavailable");
            const text = await backend.preview(
              streamKey!,
              request.audioSession.sequence!,
              request.audio.base64,
              config.streamingModel,
              config.threads,
              lifetime,
              signal,
            );
            return [{ type: "insertText", text }];
          }
          if (installing || recognizing)
            throw new Error("Speech engine is busy");
          recognizing = true;
          try {
            const text = await backend.transcribe(
              request.audio.base64,
              String(config.values.language ?? "auto"),
              config.threads,
              signal,
              config.model,
            );
            return [{ type: "insertText", text }];
          } finally {
            recognizing = false;
          }
        },
      },
    ],
  };
};
