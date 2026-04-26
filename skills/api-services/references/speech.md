# Speech Service (`services/speech`)

## `ISpeechProvider` interface

The provider interface — implemented by ElevenLabs (TTS) and Whisper (STT):

| Member | Type | Notes |
|:-------|:-----|:------|
| `.textToSpeech(opts)` | `Promise<TextToSpeechResult>` | Synthesize speech from text |
| `.speechToText(opts)` | `Promise<SpeechToTextResult>` | Transcribe audio to text |
| `.getVoices()` | `Promise<Voice[]>` | List available voices (TTS providers only) |
| `.healthCheck()` | `Promise<boolean>` | Liveness check |
| `.supportsTTS` | `boolean` | Check before calling `textToSpeech` |
| `.supportsSTT` | `boolean` | Check before calling `speechToText` |
| `.name` | `string` | Provider identifier (e.g., `'elevenlabs'`) |

## `SpeechService` orchestrator

`SpeechService` does **not** expose `textToSpeech`/`speechToText` directly. It manages independent TTS and STT provider instances. Access the underlying providers via accessors:

| Method | Return | Notes |
|:-------|:-------|:------|
| `.getTTSProvider()` | `ISpeechProvider` | Throws `McpError(InvalidRequest)` if no TTS provider configured |
| `.getSTTProvider()` | `ISpeechProvider` | Throws `McpError(InvalidRequest)` if no STT provider configured |
| `.hasTTS()` | `boolean` | Check if TTS is available |
| `.hasSTT()` | `boolean` | Check if STT is available |
| `.healthCheck()` | `Promise<{ tts: boolean; stt: boolean }>` | Checks both providers in parallel |

## Providers

| Provider | Capability | Tier 3 peer |
|:---------|:-----------|:------------|
| `ElevenLabsProvider` | TTS only (`supportsTTS: true`, `supportsSTT: false`) | ElevenLabs API (direct HTTP) |
| `WhisperProvider` | STT only (`supportsTTS: false`, `supportsSTT: true`) | OpenAI Whisper API (direct HTTP, no `openai` SDK). 25MB file size limit. |

## Configuration

| Env Var | Purpose |
|:--------|:--------|
| `SPEECH_TTS_ENABLED` | Enable TTS (`true`/`false`) |
| `SPEECH_TTS_API_KEY` | TTS provider API key (e.g., ElevenLabs) |
| `SPEECH_TTS_DEFAULT_MODEL_ID` | Default TTS model ID |
| `SPEECH_TTS_DEFAULT_VOICE_ID` | Default TTS voice ID |
| `SPEECH_STT_ENABLED` | Enable STT (`true`/`false`) |
| `SPEECH_STT_API_KEY` | STT provider API key (e.g., OpenAI) |

## Usage

```ts
// Text-to-Speech — access the provider, then call methods on it
const ttsProvider = speechService.getTTSProvider();
const ttsResult = await ttsProvider.textToSpeech({
  text: 'Hello, world!',
  voice: { voiceId: 'some-voice-id' },
  format: 'mp3',
});

// Speech-to-Text
const sttProvider = speechService.getSTTProvider();
const sttResult = await sttProvider.speechToText({
  audio: buffer,
  format: 'mp3',
  language: 'en',
});

// List available voices
const voices = await ttsProvider.getVoices();

// Health check
const health = await speechService.healthCheck();
// health: { tts: boolean, stt: boolean }
```
