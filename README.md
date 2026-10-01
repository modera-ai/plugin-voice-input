# Local Voice Input

Enable this plugin in a project, then click the download button beside the
composer. Python 3.10+ with venv support must be available; configure its executable
in plugin settings when it is not on PATH. Installation creates a private venv,
installs sherpa-onnx 1.13.8, and downloads the pinned SenseVoice int8 model (about
239 MB) and tokens. Downloads require access to PyPI and Hugging Face. Failed
installations can be retried with the same button; incomplete downloads are removed.
The model download source can be changed to hf-mirror.com in plugin settings.

After installation, click the microphone, speak, and click stop. Recognition runs
offline on CPU and appends text to the draft without sending a message. Cancel
discards the recording or a pending result. Recordings are limited to two minutes,
remain in memory, and are never saved or uploaded. Switching conversations or
disabling the plugin releases the microphone and prevents late draft writes.
Each recognition uses a short-lived process, releasing model memory on completion.

This version provides STT, not reply narration or live partial transcription.
Model and runtime licenses are independent of this plugin's MIT license.
Model: https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17

## Host extension contract

- Composer actions can declare `audioInput.maxDurationSeconds` and require
  `audio.record`. Only their execute operation accepts `request.audio`, a bounded
  base64 mono 16 kHz PCM16 WAV. Audio operations have a 120-second deadline.
- Composer UI contributions declare `audioInput.contributionId`, scoped to their
  own plugin, and optionally a declared `prepareAction`. Views return typed
  `audioInput` readiness, preparation and error state. The host renders controls and never grants guest iframe
  microphone or composer DOM access.
- The host appends returned `insertText` edits to the original draft, checks its
  lifetime revision, and notifies draft subscribers. Existing text is preserved.
- Plugin activation, project availability, declared permissions and revocation
  still apply to every backend invocation. Models and installation belong entirely
  to the plugin; no speech engine dependency is added to the host.
- Host composer calls optionally carry a UUID `requestId`; `composer.cancel`
  aborts only that renderer's operation. Cancel, unmount and plugin revocation
  terminate cooperative inference processes rather than merely hiding results.
