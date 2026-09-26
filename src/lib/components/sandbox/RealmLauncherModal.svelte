<script>
  /**
   * Realm Launcher modal (Wave B, ticket b309e02; Wave T, ticket 2b5db57;
   * launcher redesign, ticket e1e8775): a two-step wizard that launches a
   * Realm from a launch template and then (optionally) seeds it.
   *
   * Redesign decomposition (e1e8775): this component is the composition root —
   * it owns the launch/seed draft state, the catalog selection, the validation
   * projections, the launch/seed calls, and the modal shell (header, step rail,
   * banners, review gate, footers). Every section renders through a focused
   * subcomponent under this folder:
   * `RealmLauncherTemplatePicker` (catalog select + import/export/delete),
   * `RealmLauncherInputsPanel` (shape-tagged input requirements + filesets),
   * `RealmLauncherPayloadPanel` (payload attach/candidates/library + pin),
   * `RealmLauncherSeedPreview` (template seed summary + directives),
   * `RealmLauncherAgentsPreview` (capability preview + disclosures + prompts),
   * `RealmLauncherAuthoritiesPanel` (declared authority approvals + trust),
   * `RealmLauncherExtensionsPanel` (requested extensions + references),
   * `RealmLauncherSeedStep` (receipt + missing extensions + seed form), and
   * `RealmLauncherFilesDialog` (resolved placement contents). Shared styles
   * live in `realmLauncherUi.css`, scoped under `.realm-launcher-modal`.
   *
   * Step 1 — template picker plus name/color/description inputs, the hydration
   * workspace, the per-agent capability preview built from
   * `realmCatalog.summarizeAgentCapabilities` (name, role, privilege badge,
   * resolved tool grants partitioned into mutating/read-only, the model-preset
   * binding, and the `initialPrompt`/`triggerPolicy`/`modelPresetId`/
   * `privileged` disclosures with their semantics disclaimers). The launch
   * calls `sandboxStore.launchRealmFromTemplate`, so the store creates the
   * record, materializes the template, and rolls back a partial launch on
   * failure (the coded rollback report is surfaced inline).
   *
   * Wave T additions: the picker lists the effective catalog with store source
   * labels (`shipped` / `imported` / `imported · replaces shipped`), imports a
   * canonical bundle file, exports the effective bundle as canonical JSON, and
   * deletes imports behind an inline confirmation (shipped revisions have no
   * delete path).
   *
   * Wave U review completion (ticket 458e727): the review renders composed
   * prompts with per-part provenance, baked history entries editable at their
   * source inputs, an attach control for a hydration payload (a session
   * candidate from `listPendingInstancePayloads()` or a local
   * `<templateId>.package.json`), a files dialog with the resolved content of
   * every seed slot (`fixed` slots read-only — the format forbids overriding
   * them), explicit per-agent approvals for each template-declared publishing
   * authority with a "trust this template" override, the `initialPrompt` /
   * `triggerPolicy` / `modelPresetId` / `privileged` disclosures, and a
   * mandatory review acknowledgement that gates the launch button. Approved
   * pairs and the trust decision travel as `authorityApprovals` /
   * `trustAuthorities`; the validated payload travels as `{ package }`.
   *
   * Wave U carry-over (ticket a997a8a items 2–3): the review validates the
   * attached payload against the effective bundle version — the files dialog
   * resolves payload content only once a version mismatch is explicitly
   * confirmed, exactly like the launch gate — and each preview disclosure
   * carries the catalog's semantics disclaimer.
   *
   * Step 2 — seed the freshly launched Realm: file rows (path + content), an
   * optional directive, and a target picker (Realm-global default or one
   * launched member), calling `sandboxStore.seedRealm`. The success receipt
   * lists the written paths, workspace, and directive delivery; a partial-seed
   * failure reports the already-written paths instead of hiding them.
   *
   * Hydration workspace (ticket 874182b): the input card is the first-class
   * hydration surface — per-input label/brief/required/shape, per-file sizes and
   * resolved placement destinations (root joins included), in-place file
   * replacement, the full declared-directive review resolved through the
   * catalog resolver, and a review-time template-pin + canonical payload-digest
   * card. The payload card additionally exposes the session saved-payload
   * library (`realmPayloadLibrary`): save the assembled payload under a name,
   * attach a saved payload to the launch, download it, or delete it.
   *
   * The launched Realm and its members appear in the sidebar immediately: the
   * store's reactive `realms`/`agents` projections drive the drawer grouping,
   * so the wizard does not need to touch the sidebar.
   */
  import './realmLauncherUi.css';
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { triggerBrowserBlobDownload } from '../../sandbox/fsDownloadUtils/index.ts';
  import {
    buildRealmDirectiveReview,
    buildRealmHydrationPinView,
    buildRealmSavedPayloadFilename
  } from './realmHydrationHelpers.ts';
  import { realmPayloadLibrary } from './realmPayloadLibrary.ts';
  import {
    buildRealmPreviewProjection,
    buildRealmSeedSummary,
    buildRealmV2InputDrafts,
    buildSeedTargetOptions,
    describeRealmLaunchError,
    describeRealmSeedError,
    resetRealmV2InputDraft,
    setRealmV2InputFiles,
    setRealmV2InputText,
    validateRealmInputAttachments,
    validateRealmLaunchDraft,
    validateRealmV2InputDrafts,
    validateSeedDraft
  } from './realmLauncherHelpers.ts';
  import {
    buildRealmTemplateCatalogEntries,
    buildRealmTemplateExportFilename,
    describeRealmTemplateDeleteError,
    describeRealmTemplateExportError,
    describeRealmTemplateImportError,
    describeRealmTemplateImportReceipt,
    formatRealmLaunchTimestamp
  } from './realmTemplateHelpers.ts';
  import {
    assembleRealmAuthorityApprovals,
    assembleRealmExtensionApprovals,
    buildRealmAuthorityDecisions,
    buildRealmAuthorityDecisionKey,
    buildRealmAuthorityReviewAgents,
    buildRealmExtensionDecisions,
    buildRealmPayloadFilename,
    buildRealmPendingPayloadViews,
    buildRealmReviewFileSlots,
    describeRealmAuthorityTrust,
    describeRealmLaunchGate,
    parseRealmPayloadFileText,
    previewRealmReviewPackage,
    resolveRealmReviewLaunchPayload,
    serializeRealmPendingPayload
  } from './realmReviewHelpers.ts';
  import {
    buildExtensionInstallPrefill,
    buildMissingExtensionFlowViews,
    buildRealmExtensionReferenceViews,
    buildRealmExtensionRequestViews,
    describeExtensionAttachError
  } from './extensionUiHelpers.ts';
  import { safeRealmColor } from './realmGroups.ts';
  import ExtensionInstallDialog from './ExtensionInstallDialog.svelte';
  import RealmLauncherTemplatePicker from './RealmLauncherTemplatePicker.svelte';
  import RealmLauncherInputsPanel from './RealmLauncherInputsPanel.svelte';
  import RealmLauncherPayloadPanel from './RealmLauncherPayloadPanel.svelte';
  import RealmLauncherSeedPreview from './RealmLauncherSeedPreview.svelte';
  import RealmLauncherAgentsPreview from './RealmLauncherAgentsPreview.svelte';
  import RealmLauncherAuthoritiesPanel from './RealmLauncherAuthoritiesPanel.svelte';
  import RealmLauncherExtensionsPanel from './RealmLauncherExtensionsPanel.svelte';
  import RealmLauncherSeedStep from './RealmLauncherSeedStep.svelte';
  import RealmLauncherFilesDialog from './RealmLauncherFilesDialog.svelte';

  /** @typedef {import('../../sandbox/sandboxStore/index.svelte.ts').RealmLaunchReceipt} RealmLaunchReceipt */
  /** @typedef {import('../../sandbox/sandboxStore/index.svelte.ts').RealmSeedReceipt} RealmSeedReceipt */

  let { onclose = () => {} } = $props();

  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));
  let step = $state(1);
  let validationError = $state('');
  let notice = $state('');
  let isLaunching = $state(false);
  let isSeeding = $state(false);

  // Baked launch catalog comes from the store (the launch composition root);
  // the picker starts unselected so the operator makes an explicit choice.
  // The store's template registry is a plain projection, so the local revision
  // counter re-resolves the catalog after an import/delete.
  let catalogRevision = $state(0);
  let catalog = $derived.by(() => {
    void catalogRevision;
    return {
      templates: sandboxStore.listRealmTemplates(),
      entries: buildRealmTemplateCatalogEntries(
        sandboxStore.listRealmTemplates(),
        sandboxStore.listRealmTemplateSources()
      )
    };
  });
  let templates = $derived(catalog.templates);
  let catalogEntries = $derived(catalog.entries);
  let selectedTemplateId = $state('');
  let selectedTemplate = $derived(
    templates.find((template) => template.id === selectedTemplateId) ?? null
  );
  let selectedTemplateEntry = $derived(
    catalogEntries.find((entry) => entry.id === selectedTemplateId) ?? null
  );
  let preview = $derived(buildRealmPreviewProjection(selectedTemplate));

  // Launch draft
  let realmName = $state('');
  let realmColor = $state('#7c9cff');
  let realmDescription = $state('');
  let inputDrafts = $state(/** @type {import('./realmLauncherHelpers.ts').RealmInputDraft[]} */([]));
  let inputErrors = $state(/** @type {Record<string, string>} */({}));

  // The launch bundle seam: the preview resolves the same bundle files the
  // store's launch materializes with (today the baked demo bundle has none).
  let bundleFiles = $derived(
    selectedTemplate ? (sandboxStore.getRealmTemplateBundle(selectedTemplate.id)?.files ?? {}) : {}
  );
  let seedSummary = $derived(buildRealmSeedSummary(selectedTemplate));
  let seedAfterLaunch = $state(true);

  // Seed draft
  let launchReceipt = $state(/** @type {RealmLaunchReceipt | null} */(null));
  let seedReceipt = $state(/** @type {RealmSeedReceipt | null} */(null));
  let seedRows = $state(/** @type {Array<{ path: string, content: string }>} */([]));
  let seedDirective = $state('');
  let seedTargetId = $state('');
  let seedDirectiveRequested = $state(false);

  // Wave U review state (ticket 458e727): payload attachment, per-slot review
  // edits, declared-authority decisions, the trust override, the version
  // mismatch confirmation, and the mandatory review acknowledgement.
  let payloadSourceKind = $state(/** @type {'none' | 'candidate' | 'saved' | 'file'} */('none'));
  let payloadCandidateId = $state('');
  let payloadSavedId = $state('');
  let savedPayloadName = $state('');
  let savedPayloadError = $state('');
  let libraryRevision = $state(0);
  let payloadFileValue = $state(/** @type {Record<string, unknown> | null} */(null));
  let payloadFileName = $state('');
  let payloadFileError = $state('');
  let payloadRevision = $state(0);
  let fileEdits = $state(/** @type {Record<string, string>} */({}));
  let filesDialogOpen = $state(false);
  let authorityDecisions = $state(/** @type {Record<string, 'approved' | 'declined' | 'trusted'>} */({}));
  let trustTemplate = $state(false);
  let trustRevision = $state(0);
  let reviewAcknowledged = $state(false);
  let mismatchConfirmed = $state(false);
  let reviewNotice = $state('');
  let launchApprovals = $state(/** @type {Array<{ agentKey: string, authority: string }>} */([]));

  let launchedMembers = $derived(
    launchReceipt ? launchReceipt.agents.map((agent) => ({ id: agent.id, name: agent.name })) : []
  );
  let seedTargetOptions = $derived(
    buildSeedTargetOptions(launchedMembers, launchReceipt ? launchReceipt.realm.name : null)
  );

  // ---- Wave U review projections -----------------------------------------

  /** Effective bundle content version (the package pin review validates against). */
  let effectiveBundleVersion = $derived(
    selectedTemplateEntry && typeof selectedTemplateEntry.templateVersion === 'string'
      ? selectedTemplateEntry.templateVersion
      : null
  );

  /** Session candidates for the selected template (re-read after a clear). */
  let pendingPayloads = $derived.by(() => {
    void payloadRevision;
    return buildRealmPendingPayloadViews(
      selectedTemplateId,
      sandboxStore.listPendingInstancePayloads(),
      formatRealmLaunchTimestamp
    );
  });

  /** The attached payload value: a submitted candidate, a saved payload, or the parsed local file. */
  let attachedPayload = $derived(
    payloadSourceKind === 'candidate' && payloadCandidateId === selectedTemplateId
      ? (sandboxStore.getPendingInstancePayload(selectedTemplateId)?.payload ?? null)
      : payloadSourceKind === 'saved'
        ? (realmPayloadLibrary.getRealmSavedPayload(payloadSavedId)?.payload ?? null)
        : payloadSourceKind === 'file'
          ? payloadFileValue
          : null
  );

  let payloadSourceLabel = $derived(
    payloadSourceKind === 'candidate' && attachedPayload
      ? `candidate for "${selectedTemplateId}"`
      : payloadSourceKind === 'saved' && attachedPayload
        ? `saved payload "${realmPayloadLibrary.getRealmSavedPayload(payloadSavedId)?.name ?? payloadSavedId}"`
        : payloadSourceKind === 'file' && attachedPayload
          ? (payloadFileName || 'local payload file')
          : ''
  );

  /** Saved payloads for the selected template (re-read after a library mutation). */
  let savedPayloads = $derived.by(() => {
    void libraryRevision;
    return realmPayloadLibrary.listRealmSavedPayloads().filter((entry) => entry.templateId === selectedTemplateId);
  });

  /** The persisted trust record for the selected template. */
  let trustRecord = $derived.by(() => {
    void trustRevision;
    if (!selectedTemplateId) return null;
    const all = sandboxStore.listTemplateAuthorityTrust();
    return all[selectedTemplateId] ?? null;
  });
  let trustView = $derived(describeRealmAuthorityTrust(selectedTemplate, trustRecord));

  /** Declared-authority disclosure rows (agents with at least one declaration). */
  let authorityAgents = $derived(buildRealmAuthorityReviewAgents(selectedTemplate));
  let unknownAuthorities = $derived([
    ...new Set(authorityAgents.flatMap((row) => row.unknownAuthorities.map((entry) => entry.authority)))
  ]);

  // ---- Extension disclosure and attach approvals (extension wave) ----------

  let extensionRevision = $state(0);
  let extensionDecisions = $state(/** @type {Record<string, 'approved' | 'declined'>} */({}));
  let installAssist = $state(
    /** @type {{ prefill: import('./extensionUiHelpers.ts').ExtensionInstallDraft, authorComment: string } | null} */(null)
  );

  /** Global install records (re-read after an assist install). */
  let installedExtensions = $derived.by(() => {
    void extensionRevision;
    return sandboxStore.listExtensions();
  });

  /**
   * Requested extensions with their pre-launch resolution state (no Realm
   * attachments exist yet) plus the live connection disclosure (status,
   * third-party label, catalog fidelity, requested-but-not-connected copy).
   */
  let extensionRequests = $derived(buildRealmExtensionRequestViews(
    selectedTemplate,
    installedExtensions,
    [],
    sandboxStore.extensionConnections
  ));

  /** Per-agent `<providerId>::<serverToolName>` references with their resolution state. */
  let extensionReferences = $derived(buildRealmExtensionReferenceViews(selectedTemplate, installedExtensions));

  /**
   * Live missing-extension flow of the launched Realm (step 2): the requested
   * extensions recorded as missing at launch, with the install/attach actions
   * that are currently available. Nothing installs or attaches automatically.
   */
  let launchMissingFlow = $derived.by(() => {
    void extensionRevision;
    const receipt = launchReceipt;
    if (!receipt) return [];
    const realm = sandboxStore.getRealm(receipt.realm.id) ?? receipt.realm;
    const missing = realm.instance && Array.isArray(realm.instance.missingExtensions)
      ? realm.instance.missingExtensions
      : [];
    if (missing.length === 0) return [];
    return buildMissingExtensionFlowViews({
      missingExtensionIds: missing,
      template: selectedTemplate,
      installs: installedExtensions,
      attachments: sandboxStore.listRealmExtensions(realm.id)
    }).filter((view) => view.state !== 'active');
  });

  /**
   * Resolves the declared provider behind one requested extension id.
   *
   * @param {string} extensionId - Requested extension id.
   * @returns {import('../../sandbox/realmCatalog/index.ts').RealmProvider | null} Provider, or null.
   */
  function providerFor(extensionId) {
    if (!selectedTemplate) return null;
    const providers = Array.isArray(selectedTemplate.providers) ? selectedTemplate.providers : [];
    return providers.find((provider) => provider && provider.id === extensionId) ?? null;
  }

  /**
   * Records one requested-extension approval decision (unchecked = declined);
   * every change re-arms the review acknowledgement.
   *
   * @param {string} extensionId - Requested extension id.
   * @param {boolean} checked - New checkbox state.
   */
  function setExtensionDecision(extensionId, checked) {
    extensionDecisions = { ...extensionDecisions, [extensionId]: checked ? 'approved' : 'declined' };
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Opens the prefilled install assist for one requested extension (review
   * surface). Nothing is fetched or installed until the operator submits the
   * dialog.
   *
   * @param {string} extensionId - Requested extension id.
   */
  function openProviderInstallAssist(extensionId) {
    clearMessages();
    installAssist = {
      prefill: buildExtensionInstallPrefill(providerFor(extensionId), {
        templateId: selectedTemplateId,
        templateNotes: selectedTemplate ? selectedTemplate.notes : undefined,
        installSource: 'template-assist'
      }),
      authorComment: selectedTemplate && typeof selectedTemplate.notes === 'string'
        ? selectedTemplate.notes.trim().slice(0, 600)
        : ''
    };
  }

  /**
   * Opens the install assist from a missing-extension flow row (step 2), using
   * the row's template-derived prefill.
   *
   * @param {import('./extensionUiHelpers.ts').MissingExtensionFlowView} view - Missing flow row.
   */
  function openMissingInstallAssist(view) {
    clearMessages();
    installAssist = { prefill: view.installPrefill, authorComment: view.authorComment };
  }

  /**
   * Records one assist install; attachment stays an explicit operator action.
   *
   * @param {{ id: string, displayName?: string }} record - Installed record.
   */
  function handleExtensionAssistInstalled(record) {
    installAssist = null;
    extensionRevision += 1;
    notice = `Installed "${record.displayName || record.id}". Attach it to a Realm when ready — nothing attaches automatically.`;
  }

  /**
   * Attaches one installed extension to the launched Realm (step 2) with the
   * realm-level `'all'` selection; nothing connects.
   *
   * @param {import('./extensionUiHelpers.ts').MissingExtensionFlowView} view - Missing flow row.
   */
  function handleAttachMissingExtension(view) {
    const receipt = launchReceipt;
    if (!receipt) return;
    clearMessages();
    try {
      sandboxStore.attachExtension(receipt.realm.id, view.extensionId);
      extensionRevision += 1;
      notice = `Attached "${view.displayName || view.extensionId}" to "${receipt.realm.name}".`;
    } catch (err) {
      validationError = describeExtensionAttachError(err);
    }
  }

  // ---- Format-v2 launch inputs (ticket a71198f) ---------------------------

  /**
   * Operator-assembled input values validated through the store's own v2 path:
   * the effective values are synthesized into the canonical payload envelope
   * and validated by the real `validatePayload`, so missing required inputs,
   * pin mismatches, unknown inputs, and shape mismatches surface with typed
   * classes before any launch.
   */
  let inputProjection = $derived(validateRealmV2InputDrafts(selectedTemplate, inputDrafts, {
    currentVersion: effectiveBundleVersion,
    allowVersionMismatch: mismatchConfirmed,
    payload: attachedPayload,
    bundleFiles
  }));

  /**
   * Fileset attachment issues `validatePayload` cannot see (placements/selections).
   * Validated against the effective values (`inputProjection.effectiveInputs`) so
   * a required fileset supplied by the attached payload satisfies the gate
   * (ticket 0ea4c2b).
   */
  let attachmentValidation = $derived(validateRealmInputAttachments(selectedTemplate, inputDrafts, {
    inputs: inputProjection.effectiveInputs
  }));

  /** Effective shape-tagged input values for the review projections. */
  let reviewInputValues = $derived(inputProjection.effectiveInputs);

  /**
   * Declared-directive review resolved against the effective input values
   * (directives are derived content, edited at their bound input).
   */
  let directiveReview = $derived(buildRealmDirectiveReview(selectedTemplate, reviewInputValues));

  /** Input ids the attached payload provides (from the validated projection). */
  let payloadInputIds = $derived(new Set(
    inputProjection.resolved.filter((entry) => entry.source === 'payload').map((entry) => entry.id)
  ));

  /** Review file slots with their resolved provenance and edits. */
  let fileSlots = $derived(buildRealmReviewFileSlots(selectedTemplate, bundleFiles, {
    payload: attachedPayload,
    inputs: inputProjection.launchInputs,
    edits: fileEdits,
    // a997a8a item 2: the review validates against the effective bundle
    // version; a mismatching payload resolves content only after the explicit
    // mismatch confirmation (the same condition the launch gate blocks on).
    currentVersion: effectiveBundleVersion,
    allowVersionMismatch: mismatchConfirmed
  }));
  let editedFileSlotCount = $derived(fileSlots.filter((slot) => slot.edited).length);
  let conflictedFileSlotCount = $derived(fileSlots.filter((slot) => slot.conflict).length);

  /**
   * The payload the launch will actually send: the attached source verbatim
   * while unedited, else the package rebuilt from the current review slots, so
   * a "Edited — travels in the launch payload" slot can never be dropped.
   * A placement conflict or an unassemblable edit set blocks the gate.
   */
  let reviewLaunchPayload = $derived(resolveRealmReviewLaunchPayload({
    templateId: selectedTemplateId,
    templateVersion: effectiveBundleVersion,
    source: attachedPayload,
    slots: fileSlots
  }));
  let launchPayload = $derived(reviewLaunchPayload.payload);

  /** Validation of the package that will actually launch (source or rebuilt package). */
  let payloadPreview = $derived(previewRealmReviewPackage(selectedTemplate, launchPayload, {
    currentVersion: effectiveBundleVersion
  }));

  /**
   * Review-time template pin + canonical payload digest card: the reviewed
   * content is the launch package when one exists, else the synthesized
   * envelope of the effective values.
   */
  let hydrationPinView = $derived.by(() => {
    const reviewed = launchPayload
      ?? (inputProjection.ok && inputProjection.payload ? inputProjection.payload : null);
    return buildRealmHydrationPinView({
      templateId: selectedTemplateId,
      templateVersion: effectiveBundleVersion,
      payload: reviewed ?? undefined,
      sourceLabel: payloadSourceLabel || (reviewed ? 'assembled inputs' : 'no payload attached')
    });
  });

  /** Blocking payload problem (unassemblable edits, placement conflict, invalid package, unreadable file). */
  let payloadBlockReason = $derived.by(() => {
    if (reviewLaunchPayload.blocked) return reviewLaunchPayload.error;
    if (launchPayload && !payloadPreview.ok) return payloadPreview.error;
    return payloadFileError;
  });

  /** Blocking input/preview problem (typed input failure, attachment issue, preview failure). */
  let previewBlockReason = $derived.by(() => {
    if (!inputProjection.ok) return inputProjection.error;
    if (!attachmentValidation.ok) return attachmentValidation.issues[0].error;
    if (selectedTemplate && !preview.ok) return preview.error;
    return '';
  });

  /** Mandatory review/launch gate projection. */
  let launchGate = $derived(describeRealmLaunchGate({
    reviewed: reviewAcknowledged,
    previewError: previewBlockReason,
    payloadError: payloadBlockReason,
    mismatchUnconfirmed: payloadPreview.mismatch && !mismatchConfirmed,
    unknownAuthorities
  }));

  /** Review decisions for one declared pair (absent = declined). */
  function authorityDecision(agentKey, authority) {
    return authorityDecisions[buildRealmAuthorityDecisionKey(agentKey, authority)] ?? 'declined';
  }

  function clearMessages() {
    validationError = '';
    notice = '';
    reviewNotice = '';
  }

  /**
   * Resets the Wave U review state for a template selection: detaches the
   * payload, clears review file edits and decisions, rebuilds the declared
   * authority decisions from the persisted trust record (exact matches render
   * trust-auto-approved), and re-arms the mandatory review acknowledgement and
   * mismatch confirmation.
   *
   * @param {import('../../sandbox/realmCatalog/index.ts').RealmTemplate | null} template - Newly selected template, or null.
   */
  function resetReviewState(template) {
    payloadSourceKind = 'none';
    payloadCandidateId = '';
    payloadSavedId = '';
    payloadFileValue = null;
    payloadFileName = '';
    payloadFileError = '';
    savedPayloadError = '';
    fileEdits = {};
    filesDialogOpen = false;
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    launchApprovals = [];
    installAssist = null;
    extensionDecisions = buildRealmExtensionDecisions(template);
    const trust = template ? sandboxStore.listTemplateAuthorityTrust()[template.id] ?? null : null;
    authorityDecisions = buildRealmAuthorityDecisions(template, trust);
    trustTemplate = trust !== null;
  }

  /**
   * Applies a template selection to the launch draft: prefills the name and
   * description and rebuilds the input drafts from the selected bundle files
   * (the same bundle the launch materializes with). Selecting nothing clears
   * the template-driven draft.
   *
   * @param {string} templateId - Template id to select.
   */
  function applyTemplateSelection(templateId) {
    selectedTemplateId = templateId;
    const template = templates.find((entry) => entry.id === templateId) ?? null;
    if (!template) {
      realmName = '';
      realmDescription = '';
      inputDrafts = [];
      inputErrors = {};
      resetReviewState(null);
      return;
    }
    realmName = template.name;
    realmDescription = template.description;
    inputDrafts = buildRealmV2InputDrafts(
      template,
      sandboxStore.getRealmTemplateBundle(template.id)?.files ?? {}
    );
    inputErrors = {};
    seedAfterLaunch = true;
    resetReviewState(template);
  }

  /**
   * Applies the operator's picker choice and clears the transient banners.
   *
   * @param {string} templateId - Template id read from the picker.
   */
  function handleTemplateSelect(templateId) {
    clearMessages();
    applyTemplateSelection(templateId);
  }

  /**
   * Imports one canonical template bundle file into the store registry and
   * selects the imported template. Typed catalog/store failures (malformed
   * bundle, template validation, size budget, persistence rollback) are
   * surfaced inline; the picker re-resolves from the store on success.
   *
   * @param {File} file - Picked canonical bundle file.
   */
  async function handleTemplateImport(file) {
    clearMessages();
    try {
      const payload = await file.text();
      const receipt = sandboxStore.importRealmTemplate(payload);
      catalogRevision += 1;
      applyTemplateSelection(receipt.templateId);
      notice = describeRealmTemplateImportReceipt(receipt);
    } catch (err) {
      validationError = describeRealmTemplateImportError(err);
    }
  }

  /**
   * Exports the effective bundle behind the selected template (an import when
   * one shadows the id, otherwise the shipped revision) as a canonical JSON
   * download, so the exported file re-imports to the same content version.
   */
  function handleTemplateExport() {
    if (!selectedTemplate) return;
    clearMessages();
    try {
      const json = sandboxStore.exportRealmTemplate(selectedTemplate.id);
      const filename = buildRealmTemplateExportFilename(selectedTemplate.id);
      // `triggerBrowserBlobDownload` takes bytes, not a raw string: wrap the
      // canonical JSON text (the Blob's own MIME type is used).
      const receipt = triggerBrowserBlobDownload(new Blob([json], { type: 'application/json' }), filename);
      if (receipt.success) {
        notice = `Exported "${selectedTemplate.name}" as canonical template JSON (${filename}).`;
      } else {
        validationError = `Export of "${selectedTemplate.name}" failed.`;
      }
    } catch (err) {
      validationError = describeRealmTemplateExportError(err);
    }
  }

  /**
   * Deletes the selected imported template (the picker owns the inline
   * confirmation). Deleting an import that shadowed a shipped id restores the
   * shipped revision in place; a failed persistence write rolls the delete
   * back and is surfaced inline.
   */
  function handleTemplateDelete() {
    const entry = selectedTemplateEntry;
    if (!entry || !entry.deletable) return;
    clearMessages();
    const templateId = entry.id;
    const shadowed = entry.replacesShipped;
    try {
      sandboxStore.deleteRealmTemplate(templateId);
      catalogRevision += 1;
      if (sandboxStore.getRealmTemplateBundle(templateId) !== null) {
        // The shipped revision of this id resurfaced: keep the selection.
        applyTemplateSelection(templateId);
      } else {
        applyTemplateSelection('');
      }
      notice = shadowed
        ? `Deleted the imported revision of "${templateId}" — the shipped revision resolves again.`
        : `Deleted the imported template "${templateId}".`;
    } catch (err) {
      validationError = describeRealmTemplateDeleteError(err);
    }
  }

  /**
   * Records one text field edit on a format-v2 draft (dirty presence
   * semantics) and clears its inline error.
   *
   * @param {string} inputId - Declared input id.
   * @param {string} value - New field text.
   */
  function handleInputText(inputId, value) {
    inputDrafts = inputDrafts.map((entry) =>
      entry.id === inputId ? setRealmV2InputText(entry, value) : entry
    );
    clearInputError(inputId);
  }

  /**
   * Replaces the fileset of one files draft and clears its inline error.
   *
   * @param {string} inputId - Declared input id.
   * @param {Array<{ path: string, content: string, name: string }>} files - New attachments.
   */
  function handleInputFiles(inputId, files) {
    inputDrafts = inputDrafts.map((entry) =>
      entry.id === inputId ? setRealmV2InputFiles(entry, files) : entry
    );
    clearInputError(inputId);
  }

  /**
   * Clears one inline input error and re-arms the review acknowledgement.
   *
   * @param {string} inputId - Declared input id.
   */
  function clearInputError(inputId) {
    if (inputErrors[inputId]) {
      const next = { ...inputErrors };
      delete next[inputId];
      inputErrors = next;
    }
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Resets one input draft to its template declaration (untouched presence
   * semantics: the reset field is omitted from the explicit payload again).
   *
   * An attached payload supplies this input's value at launch, so resetting a
   * text field to the template default must travel explicitly to actually
   * override it; a reset fileset is empty, which the format cannot express as
   * an explicit override, so the payload value would still apply.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Draft to reset.
   */
  function handleInputReset(draft) {
    const declaration = selectedTemplate?.inputs?.find((input) => input.id === draft.id) ?? null;
    if (!declaration) return;
    const payloadProvidesValue = payloadInputIds.has(draft.id);
    inputDrafts = inputDrafts.map((entry) => {
      if (entry.id !== draft.id) return entry;
      const reset = resetRealmV2InputDraft(entry, declaration, bundleFiles);
      return payloadProvidesValue && reset.shape === 'text' ? { ...reset, dirty: true } : reset;
    });
    clearInputError(draft.id);
  }

  /**
   * Surfaces one inline input-reading failure (attachment file/folder text).
   *
   * @param {string} message - Failure text.
   */
  function reportInputError(message) {
    validationError = message;
  }

  /**
   * Records the template-seed toggle (on by default).
   *
   * @param {boolean} checked - New toggle state.
   */
  function handleSeedToggle(checked) {
    seedAfterLaunch = checked;
    clearMessages();
  }

  function addSeedRow() {
    seedRows = [...seedRows, { path: '', content: '' }];
    clearMessages();
  }

  // ---- Wave U review handlers (ticket 458e727) ----------------------------

  /**
   * Switches the payload attachment source (`none` / `candidate` / `saved` /
   * `file`). Switching away from a candidate/file detaches the current payload;
   * the review acknowledgement is re-armed because the attached content changed.
   *
   * @param {'none' | 'candidate' | 'saved' | 'file'} value - New source kind.
   */
  function handlePayloadSourceChange(value) {
    clearMessages();
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    if (value === 'candidate') {
      payloadSourceKind = 'candidate';
      payloadCandidateId = '';
      payloadSavedId = '';
      payloadFileError = '';
      return;
    }
    if (value === 'saved') {
      payloadSourceKind = 'saved';
      payloadSavedId = '';
      payloadFileError = '';
      return;
    }
    if (value === 'file') {
      payloadSourceKind = 'file';
      payloadFileError = '';
      return;
    }
    payloadSourceKind = 'none';
    payloadCandidateId = '';
    payloadSavedId = '';
    payloadFileValue = null;
    payloadFileName = '';
    payloadFileError = '';
  }

  /**
   * Reads one local `<templateId>.package.json` payload into the review. Parse
   * failures are surfaced inline; structural validation happens against the
   * effective template before launch ({@link previewRealmReviewPackage}).
   *
   * @param {File} file - Picked package file.
   */
  async function handlePayloadFile(file) {
    clearMessages();
    payloadSourceKind = 'file';
    payloadFileName = file.name;
    payloadFileValue = null;
    payloadFileError = '';
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    try {
      const text = await file.text();
      const parsed = parseRealmPayloadFileText(text);
      if (!parsed.ok) {
        payloadFileError = parsed.error;
        return;
      }
      payloadFileValue = parsed.value;
    } catch (err) {
      payloadFileError = err && err.message ? err.message : 'The payload file could not be read.';
    }
  }

  /**
   * Attaches one pending session candidate by template id.
   *
   * @param {import('./realmReviewHelpers.ts').RealmPendingPayloadView} view - Candidate row.
   */
  function attachPayloadCandidate(view) {
    clearMessages();
    payloadSourceKind = 'candidate';
    payloadCandidateId = view.templateId;
    payloadFileError = '';
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    reviewNotice = '';
  }

  /**
   * Downloads one pending session candidate as the pretty-printed package JSON
   * the local-file payload source reads back. Candidates are session-only, so
   * a candidate cleared since the row rendered reports the absent-candidate
   * copy instead of writing an empty file.
   *
   * @param {import('./realmReviewHelpers.ts').RealmPendingPayloadView} view - Candidate row.
   */
  function downloadPayloadCandidate(view) {
    clearMessages();
    const entry = sandboxStore.getPendingInstancePayload(view.templateId);
    if (!entry) {
      payloadRevision += 1;
      notice = `No pending payload remained for "${view.templateId}".`;
      return;
    }
    try {
      const filename = buildRealmPayloadFilename(view.templateId);
      const json = serializeRealmPendingPayload(entry.payload);
      const receipt = triggerBrowserBlobDownload(new Blob([json], { type: 'application/json' }), filename);
      if (receipt.success) {
        notice = `Downloaded the pending payload for "${view.templateId}" as ${filename}.`;
      } else {
        validationError = `Download of the pending payload for "${view.templateId}" failed.`;
      }
    } catch (err) {
      validationError = err && err.message ? err.message : 'The pending payload could not be downloaded.';
    }
  }

  /**
   * Clears one pending session candidate from the store surface and detaches it
   * when it was the attached source. Candidates are session-only: clearing is
   * irreversible and the list re-reads from the store.
   *
   * @param {import('./realmReviewHelpers.ts').RealmPendingPayloadView} view - Candidate row.
   */
  function clearPayloadCandidate(view) {
    clearMessages();
    const removed = sandboxStore.clearPendingInstancePayload(view.templateId);
    payloadRevision += 1;
    if (payloadSourceKind === 'candidate' && payloadCandidateId === view.templateId) {
      payloadSourceKind = 'none';
      payloadCandidateId = '';
    }
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    notice = removed
      ? `Cleared the pending payload for "${view.templateId}".`
      : `No pending payload remained for "${view.templateId}".`;
  }

  /**
   * Saves the currently assembled payload into the session saved-payload
   * library under the operator-supplied name. The saved bytes are the same
   * canonical envelope the launch validates (`inputProjection.payload`, else
   * the reviewed launch package), and the digest is the catalog's canonical
   * `payloadDigest`.
   */
  function saveCurrentPayload() {
    clearMessages();
    savedPayloadError = '';
    if (!selectedTemplate || !selectedTemplateId) {
      savedPayloadError = 'Select a template before saving a payload.';
      return;
    }
    const reviewed = inputProjection.ok && inputProjection.payload
      ? inputProjection.payload
      : (launchPayload && payloadPreview.ok ? launchPayload : null);
    if (!reviewed) {
      savedPayloadError = inputProjection.error || 'The current inputs do not assemble into a valid payload yet.';
      return;
    }
    const version = effectiveBundleVersion
      ?? (typeof reviewed.templateVersion === 'string' ? reviewed.templateVersion : '');
    try {
      const entry = realmPayloadLibrary.saveRealmPayload({
        name: savedPayloadName,
        templateId: selectedTemplateId,
        templateVersion: version,
        payload: reviewed
      });
      libraryRevision += 1;
      savedPayloadName = '';
      notice = `Saved payload "${entry.name}" (${entry.digest}) — ${entry.inputSummary}. Session-only: the named library lives until reload.`;
    } catch (err) {
      savedPayloadError = err && err.message ? err.message : 'The payload could not be saved.';
    }
  }

  /**
   * Attaches one saved payload from the session library.
   *
   * @param {import('./realmPayloadLibrary.ts').RealmSavedPayload} entry - Saved entry.
   */
  function attachSavedPayload(entry) {
    clearMessages();
    payloadSourceKind = 'saved';
    payloadSavedId = entry.id;
    payloadFileError = '';
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    reviewNotice = '';
  }

  /**
   * Downloads one saved payload as the pretty-printed package JSON the local
   * file source reads back.
   *
   * @param {import('./realmPayloadLibrary.ts').RealmSavedPayload} entry - Saved entry.
   */
  function downloadSavedPayload(entry) {
    clearMessages();
    try {
      const filename = buildRealmSavedPayloadFilename(entry.name, entry.templateId);
      const json = serializeRealmPendingPayload(entry.payload);
      const receipt = triggerBrowserBlobDownload(new Blob([json], { type: 'application/json' }), filename);
      if (receipt.success) {
        notice = `Downloaded saved payload "${entry.name}" as ${filename}.`;
      } else {
        validationError = `Download of saved payload "${entry.name}" failed.`;
      }
    } catch (err) {
      validationError = err && err.message ? err.message : 'The saved payload could not be downloaded.';
    }
  }

  /**
   * Deletes one saved payload and detaches it when it was the attached source.
   *
   * @param {import('./realmPayloadLibrary.ts').RealmSavedPayload} entry - Saved entry.
   */
  function deleteSavedPayload(entry) {
    clearMessages();
    const removed = realmPayloadLibrary.deleteRealmSavedPayload(entry.id);
    libraryRevision += 1;
    if (payloadSourceKind === 'saved' && payloadSavedId === entry.id) {
      payloadSourceKind = 'none';
      payloadSavedId = '';
    }
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    notice = removed
      ? `Deleted saved payload "${entry.name}".`
      : `No saved payload "${entry.name}" remained.`;
  }

  /** Detaches the current payload and re-arms the review acknowledgement. */
  function detachPayload() {
    clearMessages();
    payloadSourceKind = 'none';
    payloadCandidateId = '';
    payloadSavedId = '';
    payloadFileValue = null;
    payloadFileName = '';
    payloadFileError = '';
    reviewAcknowledged = false;
    mismatchConfirmed = false;
    reviewNotice = '';
    fileEdits = {};
  }

  /**
   * Records one files-dialog edit for a non-fixed slot (keyed by slot key) and
   * re-arms the review acknowledgement.
   *
   * @param {import('./realmReviewHelpers.ts').RealmReviewFileSlot} slot - Edited slot.
   * @param {string} value - New slot content.
   */
  function setFileEdit(slot, value) {
    if (!slot || slot.editable !== true) return;
    fileEdits = { ...fileEdits, [slot.key]: value };
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Reverts one files-dialog slot to its attached-payload/bundle source.
   *
   * @param {import('./realmReviewHelpers.ts').RealmReviewFileSlot} slot - Slot to reset.
   */
  function resetFileEdit(slot) {
    if (!slot || !Object.prototype.hasOwnProperty.call(fileEdits, slot.key)) return;
    const next = { ...fileEdits };
    delete next[slot.key];
    fileEdits = next;
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Records one declared-authority decision for a launched agent
   * (`approved`/`declined`); trust-auto-approved pairs are locked and clear
   * through the trust control. Every change re-arms the review acknowledgement.
   *
   * @param {string} agentKey - Template agent key.
   * @param {string} authority - Declared authority id.
   * @param {boolean} checked - New checkbox state.
   */
  function setAuthorityDecision(agentKey, authority, checked) {
    const key = buildRealmAuthorityDecisionKey(agentKey, authority);
    authorityDecisions = { ...authorityDecisions, [key]: checked ? 'approved' : 'declined' };
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Clears the persisted "trust this template" record: every declared pair
   * re-prompts (decisions reset to declined) and already-applied grants are
   * untouched (they stay revocable through the agent settings toggles).
   */
  function clearTemplateTrust() {
    clearMessages();
    if (!selectedTemplate) return;
    const cleared = sandboxStore.clearTemplateAuthorityTrust(selectedTemplate.id);
    trustRevision += 1;
    authorityDecisions = buildRealmAuthorityDecisions(selectedTemplate, null);
    trustTemplate = false;
    reviewAcknowledged = false;
    reviewNotice = cleared
      ? 'Cleared the template trust override — every declared authority re-prompts at the next launch.'
      : 'No trust override remained for this template.';
  }

  /**
   * Toggles the "trust this template" decision persisted on a successful
   * launch (`trustAuthorities: true`).
   *
   * @param {boolean} checked - New toggle state.
   */
  function handleTrustToggle(checked) {
    trustTemplate = checked;
    reviewAcknowledged = false;
    clearMessages();
  }

  /**
   * Toggles the mandatory review acknowledgement that gates the launch.
   *
   * @param {Event} event - Change event of the acknowledgement checkbox.
   */
  function handleReviewAcknowledge(event) {
    const input = /** @type {HTMLInputElement | null} */ (event ? event.currentTarget : null);
    reviewAcknowledged = input ? input.checked : false;
    clearMessages();
  }

  /**
   * Confirms (or revokes) the explicit template-version mismatch override for
   * the attached payload.
   *
   * @param {boolean} checked - New confirmation state.
   */
  function handleMismatchConfirm(checked) {
    mismatchConfirmed = checked;
    reviewAcknowledged = false;
    clearMessages();
  }

  /** Records one saved-payload name edit and clears the save error. */
  function handleSavedName(value) {
    savedPayloadName = value;
    savedPayloadError = '';
  }

  function openFilesDialog() {
    filesDialogOpen = true;
    clearMessages();
  }

  function closeFilesDialog() {
    filesDialogOpen = false;
    clearMessages();
  }

  /**
   * Removes one seed row by index.
   *
   * @param {number} index - Row index.
   */
  function removeSeedRow(index) {
    seedRows = seedRows.filter((_, position) => position !== index);
    clearMessages();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      if (filesDialogOpen) {
        closeFilesDialog();
        return;
      }
      onclose();
      return;
    }
    if (e.key === 'Tab' && modalRef) {
      const focusable = modalRef.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = /** @type {HTMLElement} */ (focusable[0]);
      const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
      if (e.shiftKey) {
        if (document.activeElement === first || !modalRef.contains(document.activeElement)) {
          last.focus();
          e.preventDefault();
        }
      } else if (document.activeElement === last || !modalRef.contains(document.activeElement)) {
        first.focus();
        e.preventDefault();
      }
    }
  }

  /**
   * Validates the launch draft (selection, name, uniqueness, the
   * operator-assembled format-v2 inputs through the store's own payload path,
   * and the fileset attachments) and launches the Realm from the selected
   * template bundle; success advances to the seed step. When the template
   * declares a seed and the toggle stays on, the store applies the seed
   * atomically as part of the launch; the manual seed step remains available
   * for post-launch edits.
   *
   * @param {SubmitEvent} e - Form submit event.
   */
  async function handleLaunch(e) {
    e.preventDefault();
    clearMessages();
    if (isLaunching) return;

    const draft = validateRealmLaunchDraft({
      templateId: selectedTemplateId,
      name: realmName,
      templateIds: templates.map((template) => template.id),
      realms: sandboxStore.realms
    });
    if (!draft.ok) {
      validationError = draft.error;
      inputErrors = { ...draft.fieldErrors };
      return;
    }
    inputErrors = {
      ...inputProjection.fieldErrors,
      ...attachmentValidation.fieldErrors
    };
    if (launchGate.disabled) {
      validationError = launchGate.hint;
      return;
    }
    inputErrors = {};
    if (!preview.ok) {
      validationError = preview.error;
      return;
    }

    const authorityApprovals = assembleRealmAuthorityApprovals(selectedTemplate, authorityDecisions);
    const attachedSources = authorityAgents.length > 0
      ? authorityApprovals.map((entry) => `${entry.agentKey} → ${entry.authority}`)
      : [];
    const extensionApprovals = assembleRealmExtensionApprovals(selectedTemplate, extensionDecisions);
    const launchInputs = inputProjection.launchInputs;

    isLaunching = true;
    try {
      const receipt = await sandboxStore.launchRealmFromTemplate(draft.templateId, {
        name: draft.name,
        color: safeRealmColor(realmColor) ?? undefined,
        description: realmDescription.trim() || undefined,
        ...(Object.keys(launchInputs).length > 0 ? { inputs: launchInputs } : {}),
        ...(seedSummary.declaresSeed && !seedAfterLaunch ? { seed: false } : {}),
        ...(launchPayload ? { payload: launchPayload } : {}),
        ...(payloadPreview.mismatch && mismatchConfirmed ? { allowVersionMismatch: true } : {}),
        ...(authorityApprovals.length > 0 ? { authorityApprovals } : {}),
        ...(extensionApprovals.length > 0 ? { extensionApprovals } : {}),
        ...(trustTemplate && authorityAgents.length > 0 ? { trustAuthorities: true } : {})
      });
      launchReceipt = receipt;
      launchApprovals = authorityApprovals;
      seedRows = [{ path: '', content: '' }];
      seedDirective = '';
      seedTargetId = '';
      seedDirectiveRequested = false;
      seedReceipt = null;
      step = 2;
      notice = seedSummary.declaresSeed && seedAfterLaunch
        ? 'Realm launched and the template seed was applied.'
        : 'Realm launched.';
      if (attachedSources.length > 0) {
        notice += ` Approved publishing authorities: ${attachedSources.join(', ')}.`;
      } else if (authorityAgents.length > 0) {
        notice += ' Declared publishing authorities were declined (unchecked).';
      }
      if (extensionApprovals.length > 0) {
        notice += ` Approved extension requests: ${extensionApprovals.map((entry) => entry.extensionId).join(', ')}.`;
      }
      const missingAtLaunch = receipt.realm.instance && Array.isArray(receipt.realm.instance.missingExtensions)
        ? receipt.realm.instance.missingExtensions
        : [];
      if (missingAtLaunch.length > 0) {
        notice += ` Requested extensions still missing: ${missingAtLaunch.join(', ')} — install or attach them below.`;
      }
    } catch (err) {
      validationError = describeRealmLaunchError(err);
    } finally {
      isLaunching = false;
    }
  }

  /**
   * Validates the seed draft and seeds the launched Realm (files, plus an
   * operator-attributed directive when one is given).
   *
   * @param {SubmitEvent} e - Form submit event.
   */
  function handleSeed(e) {
    e.preventDefault();
    clearMessages();
    if (isSeeding) return;
    const receipt = launchReceipt;
    if (!receipt) {
      validationError = 'Launch a Realm before seeding it.';
      return;
    }
    const draft = validateSeedDraft({
      rows: seedRows,
      directive: seedDirective,
      targetAgentId: seedTargetId
    });
    if (!draft.ok) {
      validationError = draft.error;
      return;
    }

    isSeeding = true;
    try {
      seedReceipt = sandboxStore.seedRealm({
        realmId: receipt.realm.id,
        files: draft.files,
        ...(draft.directive !== null ? { directive: draft.directive } : {}),
        ...(draft.targetAgentId !== null ? { targetAgentId: draft.targetAgentId } : {})
      });
      seedDirectiveRequested = draft.directive !== null;
      notice = 'Seed complete.';
    } catch (err) {
      validationError = describeRealmSeedError(err);
    } finally {
      isSeeding = false;
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div bind:this={modalRef} class="realm-launcher-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="realm-launcher-title">
    <div class="modal-header">
      <div class="header-left">
        <div class="icon-chip">
          <svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
          </svg>
        </div>
        <div>
          <h2 id="realm-launcher-title" class="modal-title">Launch Realm from Template</h2>
          <p class="modal-sub">Provision a whole Realm, preview each member's authority, then seed it</p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={() => onclose()} aria-label="Close modal">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="step-rail" aria-label="Launch steps">
      <span class="step-chip" class:active={step === 1} class:done={step > 1}>1 · Configure &amp; Preview</span>
      <span class="step-connector"></span>
      <span class="step-chip" class:active={step === 2} class:done={Boolean(seedReceipt)}>2 · Seed (optional)</span>
    </div>

    {#if validationError}
      <div class="error-banner" role="alert">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{validationError}</span>
      </div>
    {/if}
    {#if notice}
      <div class="notice-banner" role="status">
        <span>{notice}</span>
      </div>
    {/if}

    {#if step === 1}
      <form class="launcher-form" onsubmit={handleLaunch} novalidate>
        <RealmLauncherTemplatePicker
          entries={catalogEntries}
          selectedTemplateId={selectedTemplateId}
          {selectedTemplate}
          {selectedTemplateEntry}
          onselect={handleTemplateSelect}
          onimport={handleTemplateImport}
          onexport={handleTemplateExport}
          ondelete={handleTemplateDelete}
        />

        {#if !preview.ok && selectedTemplate}
          <div class="error-banner" role="alert">
            <span>Template preview unavailable: {preview.error}</span>
          </div>
        {/if}

        {#if selectedTemplate}
          <div class="create-grid">
            <div class="form-group grow">
              <label for="realm-launch-name">Realm Name <span class="req">*</span></label>
              <input
                id="realm-launch-name"
                type="text"
                bind:value={realmName}
                placeholder="e.g. Story Realm"
                class="input-field"
                oninput={clearMessages}
              />
            </div>
            <div class="form-group color-group">
              <label for="realm-launch-color">Color</label>
              <input id="realm-launch-color" type="color" bind:value={realmColor} class="color-input" />
            </div>
          </div>

          <div class="form-group">
            <label for="realm-launch-description">Description <span class="opt">(optional)</span></label>
            <input
              id="realm-launch-description"
              type="text"
              bind:value={realmDescription}
              placeholder="Operator note for this Realm"
              class="input-field"
              oninput={clearMessages}
            />
          </div>

          <RealmLauncherInputsPanel
            drafts={inputDrafts}
            {inputErrors}
            effectiveInputs={reviewInputValues}
            {payloadInputIds}
            ontext={handleInputText}
            onfiles={handleInputFiles}
            onreset={handleInputReset}
            onerror={reportInputError}
          />

          <RealmLauncherPayloadPanel
            templateId={selectedTemplateId}
            bundleVersion={effectiveBundleVersion}
            sourceKind={payloadSourceKind}
            candidateId={payloadCandidateId}
            savedId={payloadSavedId}
            {pendingPayloads}
            {savedPayloads}
            {attachedPayload}
            sourceLabel={payloadSourceLabel}
            fileError={payloadFileError}
            {payloadPreview}
            {mismatchConfirmed}
            {editedFileSlotCount}
            savedName={savedPayloadName}
            savedError={savedPayloadError}
            pinView={hydrationPinView}
            onsourcechange={handlePayloadSourceChange}
            onfile={handlePayloadFile}
            onattachcandidate={attachPayloadCandidate}
            ondownloadcandidate={downloadPayloadCandidate}
            onclearcandidate={clearPayloadCandidate}
            onattachsaved={attachSavedPayload}
            ondownloadsaved={downloadSavedPayload}
            ondeletesaved={deleteSavedPayload}
            ondetach={detachPayload}
            onmismatch={handleMismatchConfirm}
            onsavename={handleSavedName}
            onsave={saveCurrentPayload}
          />

          <RealmLauncherSeedPreview
            {seedSummary}
            {directiveReview}
            {fileSlots}
            {editedFileSlotCount}
            {conflictedFileSlotCount}
            {attachedPayload}
            {seedAfterLaunch}
            onseedtoggle={handleSeedToggle}
            onopenfiles={openFilesDialog}
          />

          <RealmLauncherAgentsPreview
            {selectedTemplate}
            rows={preview.rows}
            {bundleFiles}
            effectiveInputs={reviewInputValues}
            drafts={inputDrafts}
            oneditinput={handleInputText}
          />

          <RealmLauncherAuthoritiesPanel
            rows={authorityAgents}
            {unknownAuthorities}
            {trustView}
            {trustTemplate}
            decisionFor={authorityDecision}
            ondecision={setAuthorityDecision}
            ontrusttoggle={handleTrustToggle}
            oncleartrust={clearTemplateTrust}
          />

          <RealmLauncherExtensionsPanel
            requests={extensionRequests}
            references={extensionReferences}
            decisions={extensionDecisions}
            ondecision={setExtensionDecision}
            oninstall={openProviderInstallAssist}
          />
        {/if}

        {#if selectedTemplate}
          <div class="review-gate">
            <label class="review-ack">
              <input type="checkbox" checked={reviewAcknowledged} onchange={handleReviewAcknowledge} />
              <span>
                I reviewed the composed prompts, the resolved input values and file contents, the declared publishing
                authorities, and the requested extensions for this launch.
              </span>
            </label>
            {#if launchGate.disabled}
              <p class="launch-gate-hint" role="status">{launchGate.hint}</p>
            {/if}
          </div>
        {/if}

        <div class="modal-footer compact">
          <button type="button" class="btn-secondary" onclick={() => onclose()} disabled={isLaunching}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={isLaunching || (Boolean(selectedTemplate) && launchGate.disabled)}>
            {isLaunching ? 'Launching…' : 'Launch Realm'}
          </button>
        </div>
      </form>
    {:else}
      <RealmLauncherSeedStep
        {launchReceipt}
        {launchApprovals}
        missingFlow={launchMissingFlow}
        {seedReceipt}
        bind:seedRows
        bind:seedDirective
        bind:seedTargetId
        {seedTargetOptions}
        {seedDirectiveRequested}
        {isSeeding}
        onseed={handleSeed}
        ontargetchange={clearMessages}
        onaddrow={addSeedRow}
        onremoverow={removeSeedRow}
        onclose={() => onclose()}
        oninstallmissing={openMissingInstallAssist}
        onattachmissing={handleAttachMissingExtension}
      />
    {/if}

    {#if filesDialogOpen}
      <RealmLauncherFilesDialog
        slots={fileSlots}
        mismatchUnconfirmed={payloadPreview.mismatch && !mismatchConfirmed}
        onedit={setFileEdit}
        onreset={resetFileEdit}
        onclose={closeFilesDialog}
      />
    {/if}

    {#if installAssist}
      <ExtensionInstallDialog
        prefill={installAssist.prefill}
        contextLabel={selectedTemplate ? `template "${selectedTemplate.id}"` : ''}
        authorComment={installAssist.authorComment}
        oninstalled={handleExtensionAssistInstalled}
        onclose={() => (installAssist = null)}
      />
    {/if}
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(12, 13, 14, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1.5rem;
    animation: fade-in 0.2s ease-out;
  }
</style>
