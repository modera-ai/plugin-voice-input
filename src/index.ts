import { join } from "node:path";
import type { PluginModule } from "@modera/plugin-sdk";
import { SpeechBackend, installationError, type InstallProgress } from "./backend";

export const activate: PluginModule["activate"] = async host => {
  const backend = new SpeechBackend(join(host.storagePath, "sensevoice"));
  let installing = false, recognizing = false, error = "";
  let progress: InstallProgress | undefined;
  const permissions = ["audio.record", "process.spawn", "network.fetch", "storage.read", "storage.write"] as const;
  return {
    ui: [{
      id: "modera.voice-input.microphone", slot: "conversation.composer", requiredPermissions: permissions,
      audioInput: { contributionId: "modera.voice-input.transcribe", prepareAction: "install" }, actions: ["install"],
      async render(request) {
        const zh = request.locale.startsWith("zh");
        const label = progress?.stage === "environment" ? (zh ? "创建语音环境" : "Creating speech environment")
          : progress?.stage === "dependencies" ? (zh ? "安装语音运行库" : "Installing speech runtime")
          : progress?.stage === "verify" ? (zh ? "验证语音环境" : "Verifying speech environment")
          : progress?.file === "tokens.txt" ? (zh ? "下载词表" : "Downloading vocabulary") : (zh ? "下载语音模型" : "Downloading speech model");
        return { title: zh ? "语音输入" : "Voice input", children: [], live: installing, audioInput: {
          ready: !installing && await backend.ready(), preparing: installing, error,
          ...(progress ? { progress: { label, ...(progress.completed === undefined ? {} : { completed: progress.completed }), ...(progress.total === undefined ? {} : { total: progress.total }) } } : {}),
        } };
      },
      async act(action, context) {
        if (action.id !== "install") throw new Error("Unknown voice action");
        if (installing) return;
        if (!host.runBackground) throw new Error("Background installation unavailable");
        const config = await host.config?.read(context.projectId);
        installing = true; error = ""; progress = { stage: "environment" };
        try {
          host.runBackground({ ...context, label: "Install local SenseVoice" }, async signal => {
            try { await backend.install(String(config?.values.pythonExecutable ?? "python"), AbortSignal.any([host.signal, signal, AbortSignal.timeout(20 * 60 * 1000)]), String(config?.values.modelSource ?? "huggingface.co"), next => {
              const stageChanged = progress?.stage !== next.stage || progress?.file !== next.file;
              progress = next;
              if (stageChanged) host.invalidateUi?.();
            }); }
            catch (cause) { error = installationError(cause); }
            finally { installing = false; host.invalidateUi?.(); }
          });
        } catch (cause) { installing = false; error = installationError(cause); throw cause; }
        host.invalidateUi?.();
      },
    }],
    composer: [{
      id: "modera.voice-input.transcribe", title: "Transcribe local audio", kind: "action", requiredPermissions: permissions,
      audioInput: { maxDurationSeconds: 120 },
      async execute(request, context) {
        if (!request.audio) throw new Error("Recording required");
        if (installing || recognizing) throw new Error("Speech engine is busy");
        recognizing = true;
        try {
          const config = await host.config?.read(context.projectId);
          const text = await backend.transcribe(request.audio.base64, String(config?.values.language ?? "auto"), Number(config?.values.threads ?? 2), AbortSignal.any([context.signal, host.signal, host.scopeSignal?.(context.projectId) ?? host.signal]));
          return [{ type: "insertText", text }];
        } finally { recognizing = false; }
      },
    }],
  };
};
