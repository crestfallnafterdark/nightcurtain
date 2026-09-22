# Product Requirements Document (PRD): Unified Provider Adapter Architecture & Credential Management

**Status:** RATIFIED  
**Last verified: 2026-09-22**  
**Version:** 1.0  
**Date:** 2026-09-14  
**Scope Owner:** Product Owner & Core System Architect  
**Related Systems:** `src/lib/sandbox/inference/`, `src/lib/sandbox/runtime/index.ts`, `src/lib/sandbox/modelConfig/index.ts`, `src/lib/components/sandbox/`

> **Modernization note (2026-09-17):** Legacy field names in this ratified PRD have since been superseded in implementation — `apiKeyId` → `keyId`, `providerRouting` → `routing`, and the `vendor` / `model: 'inherit'` aliases were retired in favor of explicit `providerId` / `modelId` resolution. The delivered provider layer lives in `src/lib/sandbox/inference/` (folder modules with `index.ts` surfaces), and curated model presets live in `src/lib/sandbox/modelConfig/index.ts`.

---

## 1. Executive Summary & Objective

This document codifies the requirements for refactoring the LLM inference layer, credential storage, and provider abstraction in `ai-story`.

It completely eliminates the former monolithic 4,200-line `src/lib/api/deepseek.js` by establishing:
1. **A Single Unified Adapter Interface (`IProviderAdapter`)** with a reusable, production-grade **OpenAI Base Adapter (`OpenAICompatibleAdapter`)**.
2. **5 Native Providers**: Runware, NanoGPT, DeepSeek Native, Prem AI, and Custom OpenAI-Compatible (Ollama, vLLM, OpenRouter, Groq, etc.).
3. **Structured Central Global State vs. Per-Agent Local State** with deterministic inheritance resolution.
4. **Dedicated Labeled API Key Store (`CredentialVault`)** for managing, labeling, and switching API credentials.
5. **Connection Config Profiles & Model Presets** allowing users to save, switch, and export connection configurations.
6. **Strict Invariant: Zero Direct API Calls** anywhere in the application outside the structured client layer.

---

## 2. Functional Requirements

### 2.1 Adapter Interface & Composition (ADP)

* **ADP-1 — Universal Adapter Contract (`IProviderAdapter`)**:
  Every provider adapter must implement the exact same interface:
  * `streamChatCompletion(request)`: Server-Sent Events (SSE) streaming with delta prose, delta reasoning (`reasoning_content` / `reasoning` / `thought`), and incremental tool call accumulation (`delta.tool_calls`).
  * `chatCompletion(request)`: Non-streaming complete response.
  * `listModels(credentials, baseUrl)`: Dynamic model discovery returning standardized `{ id, name, contextWindow, description }`.
  * `checkBalance(credentials, baseUrl)`: Returns available account balance/credits `{ balance, currency, formatted, supported: boolean }`.
  * `testConnection(credentials, baseUrl)`: Validates credentials and returns `{ ok: boolean, error?: string, latencyMs?: number }`.

* **ADP-2 — Reusable OpenAI Base (`OpenAICompatibleAdapter`)**:
  * Implements all standard OpenAI Chat Completions behavior (`POST /v1/chat/completions`, standard SSE chunk parsing, authorization headers, inactivity timeouts, abort signal propagation, and tool accumulation).
  * Serves as the base class for OpenAI-compliant endpoints, allowing new providers to be created with minimal overrides (URL, custom headers, or custom balance routes).

* **ADP-3 — 5 Native Provider Implementations**:
  1. **Runware**: OpenAI base with Runware endpoint defaults and custom parameters (e.g. `max_thinking_budget`).
  2. **NanoGPT**: OpenAI base with NanoGPT routing headers (`provider` e.g. `aoru/flex`, `arnict`), custom model defaults, and `/api/v1/balance` integration.
  3. **DeepSeek Native**: OpenAI base with DeepSeek Native endpoints, `deepseek-chat` / `deepseek-reasoner` parameter handling, and balance integration.
  4. **Prem AI**: Dedicated adapter satisfying `IProviderAdapter` with Prem's asymmetric/symmetric cryptographic envelope encryption and gateway transport.
  5. **Custom OpenAI-Compatible**: Fully configurable OpenAI-standard adapter supporting arbitrary user-supplied Base URLs (Ollama, vLLM, LM Studio, LocalAI, Together, Groq, OpenRouter).

* **ADP-4 — Easy Provider Composition**:
  * Adding a new provider must require only registering a descriptor in `ProviderRegistry` or subclassing `OpenAICompatibleAdapter` for non-standard routes.

---

### 2.2 Central Global State & Per-Agent Resolution (STATE)

* **STATE-1 — Central Global Inference State**:
  * Maintains the active global default provider, default model, global credential reference, temperature, reasoning effort, and max tokens.
* **STATE-2 — Per-Agent Local State**:
  * Agents may specify dedicated overrides (`providerId`, `model`, `apiKeyId`, `temperature`, `reasoningEffort`, `providerRouting`) or specify `'inherit'`.
* **STATE-3 — Deterministic Inheritance Resolution**:
  * When an agent specifies `'inherit'` or leaves a field `undefined`, the runtime resolves the value dynamically against the central global state.
  * The string `'inherit'` must **NEVER** be passed to a provider API.

---

### 2.3 Labeled Credential Store (`CredentialVault`) (KEY)

* **KEY-1 — Isolated Labeled Key Storage**:
  * API keys and encryption keys are decoupled from generic settings and stored in a structured key store with user-defined labels (e.g., `{ id, providerId, label, apiKey, encryptionKey, createdAt, lastUsed }`).
* **KEY-2 — Masked Display & Safe Export**:
  * Keys are masked in the UI with copy/reveal toggles. Sensitive keys are excluded from public story exports unless explicitly requested.

---

### 2.4 Connection Config Profiles & Model Presets (PRESET)

* **PRESET-1 — Save & Switch Connection Profiles**:
  * Users can save current provider configurations as named connection profiles (e.g., "Runware Fast", "NanoGPT Creative", "Local Ollama 70B") and switch between them instantly.
* **PRESET-2 — Curated Model Presets**:
  * The system ships with loaded model preset slots (e.g., *Fast Storyteller*, *Deep Reasoning*, *Creative Writing*, *Local Offline*) that configure optimal model, temperature, reasoning effort, and provider routing.

---

### 2.5 Strict Architectural Invariants & Decoupling (INV)

* **INV-1 — Zero Direct API Calls**:
  * No component, store, utility, or tool in the codebase may invoke `fetch()` directly for LLM inference. All calls must route through the centralized `InferenceClient`.
* **INV-2 — Decoupling of RPG Domain Logic from Transport**:
  * Lorebook extraction, story event summarization, draft critiques, and image prompts must be separated from low-level HTTP transport into dedicated domain modules (`src/lib/api/domain/`) *(historical — that legacy directory has been removed; domain-agent logic now lives under `src/lib/sandbox/domain/`)*.
* **INV-3 — Clean Monolith Retirement**:
  * The former `src/lib/api/deepseek.js` is dismantled and replaced with the modular provider layer in `src/lib/sandbox/inference/`.

---

## 3. Acceptance Criteria

1. **[AC-PROV-01] Universal Interface**: All 5 native providers implement `IProviderAdapter` and pass standard interface contract tests.
2. **[AC-PROV-02] Dynamic Model Discovery**: Invoking `listModels()` on Runware, NanoGPT, DeepSeek, OpenRouter, or Custom returns a normalized list of live models from the provider.
3. **[AC-PROV-03] Live Balance Lookup**: Invoking `checkBalance()` on supported providers (e.g. NanoGPT, DeepSeek) returns structured available balance and currency.
4. **[AC-PROV-04] Seamless Inheritance**: Agents configured with `vendor: 'inherit'` or `model: 'inherit'` cleanly resolve to the active global defaults without sending `'inherit'` to provider APIs.
5. **[AC-PROV-05] Labeled Key Store**: API keys can be added, edited, labeled, deleted, and bound to providers/agents via `CredentialVault`.
6. **[AC-PROV-06] Connection Profiles**: Users can save, switch, export, and import connection profiles.
7. **[AC-PROV-07] Model Presets**: Built-in model presets load complete configuration profiles cleanly.
8. **[AC-PROV-08] Zero Direct Calls**: No raw `fetch` for chat completions exists outside `BaseProviderAdapter` and `PremAdapter`.
9. **[AC-PROV-09] Full Test & Build Gate**: 100% of test suites pass, zero regressions across sandbox/story modes, and `npm run build` exits with code 0.
