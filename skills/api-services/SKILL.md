---
name: api-services
description: >
  API reference for built-in service providers (LLM, Speech, Graph). Use when looking up service interfaces, provider capabilities, or integration patterns.
metadata:
  author: cyanheads
  version: "1.3"
  audience: external
  type: reference
---

## Overview

Service interfaces are deferred from core's public exports — they remain in downstream servers until shared by 2+ servers. These are documented here for core contributors and servers that use the built-in providers.

All services follow the **init/accessor pattern**: initialized in `setup()`, accessed at request time via lazy accessor. See the `add-service` skill for the full pattern.

## References

| Reference | Path | Description |
|:----------|:-----|:------------|
| LLM | `references/llm.md` | OpenRouter-based LLM provider (`ILlmProvider`, streaming, config) |
| Speech | `references/speech.md` | TTS/STT providers (`SpeechService`, ElevenLabs, Whisper) |
| Graph | `references/graph.md` | Relationship graph operations (`IGraphProvider`, traversal, pathfinding) |
