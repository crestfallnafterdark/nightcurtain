# Agent Runtime, Domain Entity & Model Configuration Remediation Specification

**Status:** RATIFIED  
**Last verified:** 2026-09-22  
**Scope:** Formal point-by-point specification for the pure Agent Domain, universal `AgentModelConfig`, KeyStore purity, inference transport contracts, domain task modernization, and test isolation. Domain-task points (Layer 4) and the legacy `gameState` fallback are retained as historical provenance — the surfaces have been removed.

---

## 1. System Architecture & Universal Contracts

```
+----------------------------------------------------------------------------------------------------+
|                       UNIVERSAL MASTER MODEL SPECIFICATION: AgentModelConfig                       |
|                                                                                                    |
|  export interface AgentModelConfig {                                                               |
|    providerId: 'runware' | 'nanogpt' | 'deepseek' | 'prem' | 'custom';                             |
|    keyId: string;            // ALWAYS PRESENT: references KeyStore entry (e.g. 'canonical_deepseek') |
|    modelId: string;          // Model identifier (e.g. 'deepseek-flash', 'deepseek-v4-flash')       |
|    url?: string;             // REQUIRED for 'custom' provider (e.g. 'http://localhost:11434/v1')  |
|    temperature?: number;     // e.g. 0.7                                                           |
|    reasoningEffort?: string; // 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh'               |
|    routing?: string;         // NanoGPT routing (e.g. 'aoru')                                      |
|    serviceTier?: string;     // NanoGPT service tier (e.g. 'flex')                                 |
|  }                                                                                                 |
+-------------------------------------------------+--------------------------------------------------+
                                                  |
                           (Exact Same Interface Used Across All Domains)
                                                  |
         +----------------------------------------+----------------------------------------+
         |                                        |                                        |
         v                                        v                                        v
[Global Default Settings]               [Every Model Preset]                     [Agent Domain Entities]
`settings.modelConfig`                  Every preset (Base & Custom) is an       `agent.modelConfig`
(DeepSeek Base Preset)                  `AgentModelConfig` (+ metadata `id/name`)         |
                                                                                          v
                                                                             Creates & Holds Provider & Model
                                                                                          |
                                                                                          v
+----------------------------------------------------------------------------------------------------+
|                                    INFERENCE & KEYSTORE LAYER                                      |
|                                                                                                    |
|  1. KeyStore (credentialVault): Pure key store (keyId -> apiKey, encryptionKey).                   |
|     ZERO baseUrls in KeyStore.                                                                     |
|                                                                                                    |
|  2. Closed Providers (Runware, DeepSeek, NanoGPT, Prem):                                           |
|     - Fixed endpoints hardcoded internally in provider implementations.                            |
|     - Resolve API keys internally from KeyStore using `keyId`.                                     |
|                                                                                                    |
|  3. Custom OpenAI-Compatible Provider (OpenAIProvider):                                            |
|     - Endpoint URL fetched ONLY from `AgentModelConfig.url`.                                       |
|     - If `providerId === 'custom'` and `url` is missing/empty -> THROWS Error immediately.          |
|     - Resolves API key from KeyStore using `keyId`.                                                |
|                                                                                                    |
|  4. maxTokens Invariant:                                                                           |
|     - Hardcoded to 100,000 internally inside provider payload builders.                            |
|     - Completely removed from all configs and API interfaces.                                      |
+----------------------------------------------------------------------------------------------------+
```

---

## 2. Point-by-Point Remediation Specification

### Layer 1: Domain Entities & KeyStore Architecture

* **Point 1.1: Single-Line Global Model Config Resolution (current form)**
  - **Requirement:** `getGlobalModelConfig(explicitSettings)` in `src/lib/sandbox/runtime/agent/index.ts` must return `explicitSettings?.modelConfig` when present, otherwise the model-catalog master default from `getDefaultModelConfig()` (`src/lib/sandbox/modelConfig/index.ts`). The sandbox never reads host globals — the legacy `window.gameState.settings.modelConfig` fallback was removed (legacy-retire T4).
  - **Constraint:** Zero hardcoded property-level fallback ternary ladders.
  - **Target Files:** `src/lib/sandbox/runtime/agent/index.ts`

* **Point 1.2: Pure Agent Composition & Zero Property Aliases**
  - **Requirement:** `Agent` constructor and `updateConfig` in `src/lib/sandbox/runtime/agent/index.ts` must perform pure composition: `this.modelConfig = { ...getGlobalModelConfig(settings), ...(config.modelConfig || {}) }`.
  - **Constraint:** Zero property aliases (`providerVendor`, `providerUrl`, `providerApiKey`, `providerEncryptionKey`, `model`).
  - **Target Files:** `src/lib/sandbox/runtime/agent/index.ts`

* **Point 1.3: Continuous Non-Null Provider & Model Contract**
  - **Requirement:** An `Agent` instance must hold valid, non-null `this.provider` and `this.model` instances at all times. If initialized from `modelConfig`, `Agent` invokes `createProvider(this.modelConfig, credentialVault)` and `this.provider.createModel(this.modelConfig.modelId, this.modelConfig)`. Injected models require their associated provider; supplying a model without a provider throws an invariant violation error.
  - **Target Files:** `src/lib/sandbox/runtime/agent/index.ts`

* **Point 1.4: KeyStore Purity & Zero BaseURL Leaks**
  - **Requirement:** The KeyStore (`credentialVault`) is strictly a key store (`keyId -> apiKey` / `encryptionKey`). `CANONICAL_PROVIDERS` is strictly restricted to `runware`, `nanogpt`, `deepseek`, `prem`, and `custom`. All `baseUrl` properties and methods must be purged from `credentialVault.js` and `ProviderInterface.js`.
  - **Target Files:** `src/lib/sandbox/credentialVault/index.ts`, `src/lib/sandbox/inference/ProviderInterface/index.ts`

* **Point 1.5: Total Interface Purity & Zero `maxTokens`**
  - **Requirement:** `maxTokens` and `max_tokens` must not exist in `AgentModelConfig`, `ModelConfig`, `agent.config`, or `settings.modelConfig`.
  - **Target Files:** `src/lib/sandbox/inference/ProviderInterface/index.ts`, `src/lib/sandbox/runtime/agent/index.ts`.

---

### Layer 2: Inference Providers & Transport Invariants

* **Point 2.1: Custom Provider Endpoint URL Enforcement & Immediate Failure**
  - **Requirement:** For `providerId === 'custom'`, the endpoint `url` is fetched strictly from `AgentModelConfig.url`. If `url` is missing, undefined, or empty, `OpenAIProvider.getEffectiveApiUrl()` and `createProvider()` must throw an immediate Error: `"Custom provider requires a valid endpoint 'url' in AgentModelConfig"`. It must never default to OpenAI or external endpoints.
  - **Target Files:** `src/lib/sandbox/inference/OpenAIProvider/index.ts`, `src/lib/sandbox/inference/createProvider/index.ts`

* **Point 2.2: Purging of KeyStore BaseURL Lookups in Providers**
  - **Requirement:** `OpenAIProvider.getEffectiveApiUrl()` must eliminate all lookups to `cred.baseUrl` and `active.baseUrl`. Endpoint URLs originate exclusively from explicit provider configuration (`this.apiUrl` from `AgentModelConfig.url`).
  - **Target Files:** `src/lib/sandbox/inference/OpenAIProvider/index.ts`

* **Point 2.3: Provider Payload 100k Token Hardcoding**
  - **Requirement:** Provider payload builders (`OpenAIProvider`, `PremProvider`) must hardcode `max_tokens = 100000` internally within their payload builders, with zero exposure in public options or config interfaces.
  - **Target Files:** `src/lib/sandbox/inference/OpenAIProvider/index.ts`, `src/lib/sandbox/inference/PremProvider/index.ts`

* **Point 2.4: Provider Response Validation & Abort Listener Hygiene**
  - **Requirement:** `PremProvider.listModels()` must validate HTTP status (`if (!response.ok) throw new Error(...)`). `retry/` must clean up the `abort` event listener when the backoff timeout completes normally.
  - **Target Files:** `src/lib/sandbox/inference/PremProvider/`, `src/lib/sandbox/inference/retry/`

---

### Layer 3: Runtime Engine & State Persistence

* **Point 3.1: Clean Composition in `launchAgent`**
  - **Requirement:** `AgentRuntime.launchAgent` must accept `config` directly, strip all loose credential/URL aliases, and pass `config` to `new Agent(config, model, provider)`. An agent's model is defined exclusively by `config.modelConfig`, composed cleanly with global settings.
  - **Target Files:** `src/lib/sandbox/runtime/index.ts`

* **Point 3.2: Concurrency & Cancellation Safety in `executeAgentTurn`**
  - **Requirement:** Before executing deferred turns queued on `agent.currentTurnPromise`, the runtime must verify that the agent is still registered/active and confirm that the execution signal has not been aborted.
  - **Target Files:** `src/lib/sandbox/runtime/index.ts`

* **Point 3.3: Serialization & Hydration State Fidelity**
  - **Requirement:** `sandboxPersistence.js` must serialize `agent.modelConfig` directly and restore agents via `new Agent(agentData.config, model, provider)`, ensuring zero credential leaks in persisted snapshots.
  - **Target Files:** `src/lib/sandbox/sandboxPersistence/index.ts`

---

### Layer 4: Domain Task Architecture Modernization (historical — `src/lib/api/domain/` removed)

> Retained as provenance for the retired legacy domain pipeline; no file in this layer is part of the current build.

* **Point 4.1: Purge All Legacy Pre-Flight Key Checks (historical)**
  - **Requirement:** All legacy domain task files (`draftCritiqueEngine.js`, `brainstormCompiler.js`, `storyEventSummarizer.js`, `imagePromptGenerator.js`, `lorebookSummarizer.js`) had their legacy pre-flight checks (`if (!resolvedCreds.apiKey) throw ...`) removed before the whole pipeline was retired.
  - **Target Files:** `src/lib/api/domain/*` (legacy, removed)

* **Point 4.2: Direct Provider Instantiation & Task Execution (historical)**
  - **Requirement:** Legacy domain tasks resolved `modelConfig` via `resolveDomainModelConfig(settings)` and delegated to `executeDomainTask()`, which instantiated the provider via `createProvider(resolvedConfig, credentialVault)`.
  - **Target Files:** `src/lib/api/domain/domainTaskExecutor.js` (legacy, removed)

---

### Layer 5: Requirements Documentation & Test Verification

* **Point 5.1: Settings Credential Isolation Requirement Recording**
  - **Requirement:** Create `docs/requirements/settings_credential_isolation.md` to document the future UI migration isolating credential storage from `gameState.settings`.
  - **Target Files:** `docs/requirements/settings_credential_isolation.md`
  - **Status:** Delivered (2026-09-17) — the ratified document exists and is cross-linked from the testing docs.

* **Point 5.2: Test Singleton Isolation & Test Lifecycle Hooks**
  - **Requirement:** Add `beforeEach` and `afterEach` lifecycle reset hooks in unit and integration test suites to reset the in-memory preset catalog and `credentialVault` to pristine baselines, preventing cross-test state pollution (the legacy `gameState.settings` reset target was retired).
  - **Target Files:** `tests/integration/agent_model_resolution_test.js`, `tests/unit/runtime_lifecycle_module_test.js`
  - **Note:** The historical `tests/unit/agent_domain_test.js` suite no longer exists; equivalent coverage lives in the integration model-resolution suite and the runtime lifecycle module suite.

* **Point 5.3: End-to-End Verification Protocol**
  - **Requirement:** All test suites in `tests/runner.js` must pass, and `npm run build` must compile cleanly with exit code 0.
  - **Target Files:** Full repository
