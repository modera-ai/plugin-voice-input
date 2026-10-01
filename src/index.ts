import { join } from "node:path";
import type { PluginModule } from "@modera/plugin-sdk";
import { SpeechBackend } from "./backend";

export const activate: PluginModule["activate"] = async host => {
  const backend = new SpeechBackend(join(host.storagePath, "sensevoice"));
  let installing = false, recognizing = false, error = "";
  const permissions = ["audio.record", "process.spawn", "network.fetch", "storage.read", "storage.write"] as const;
  return {
    ui: [{
      id: "modera.voice-input.microphone", slot: "conversation.composer", requiredPermissions: permissions,
      audioInput: { contributionId: "modera.voice-input.transcribe", prepareAction: "install" }, actions: ["install"],
      async render(request) {
        return { title: request.locale.startsWith("zh") ? "语音输入" : "Voice input", children: [], live: installing, audioInput: { ready: !installing && await backend.ready(), preparing: installing, error } };
      },
      async act(action, context) {
        if (action.id !== "install") throw new Error("Unknown voice action");
        if (installing) return;
        if (!host.runBackground) throw new Error("Background installation unavailable");
        const config = await host.config?.read(context.projectId);
        installing = true; error = "";
        try {
          host.runBackground({ ...context, label: "Install local SenseVoice" }, async signal => {
            try { await backend.install(String(config?.values.pythonExecutable ?? "python"), AbortSignal.any([host.signal, signal, AbortSignal.timeout(20 * 60 * 1000)]), String(config?.values.modelSource ?? "huggingface.co")); }
            catch (cause) { error = String(cause); }
            finally { installing = false; host.invalidateUi?.(); }
          });
        } catch (cause) { installing = false; throw cause; }
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
