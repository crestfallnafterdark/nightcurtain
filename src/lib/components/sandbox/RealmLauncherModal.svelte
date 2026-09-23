<script>
  /**
   * Realm Launcher modal (Wave B, ticket b309e02; Wave T, ticket 2b5db57): a
   * two-step wizard that launches a Realm from a launch template and then
   * (optionally) seeds it.
   *
   * Step 1 — template picker plus name/color/description inputs, with a
   * per-agent preview built from `realmCatalog.summarizeAgentCapabilities`:
   * name, role, privilege badge, resolved tool grants partitioned into
   * mutating/read-only, and the model-preset binding. The launch calls
   * `sandboxStore.launchRealmFromTemplate`, so the store creates the record,
   * materializes the template, and rolls back a partial launch on failure
   * (the coded rollback report is surfaced inline).
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
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { triggerBrowserBlobDownload } from '../../sandbox/fsDownloadUtils/index.ts';
  import {
    buildRealmDirectiveReview,
    buildRealmFileAttachmentViews,
    buildRealmHydrationPinView,
    buildRealmInputPlacementDestinations,
    buildRealmSavedPayloadFilename
  } from './realmHydrationHelpers.ts';
  import { realmPayloadLibrary } from './realmPayloadLibrary.ts';
  import {
    buildRealmInputAttachment,
    buildRealmPreviewProjection,
    buildRealmPromptPreview,
    buildRealmSeedSummary,
    buildRealmV2InputDrafts,
    buildSeedTargetOptions,
    describeRealmLaunchError,
    describeRealmPresetBinding,
    describeRealmSeedError,
    describeSeedWorkspace,
    isRealmV2InputEditable,
    resetRealmV2InputDraft,
    setRealmV2InputFiles,
    setRealmV2InputText,
    uniqueRealmAttachmentPath,
    validateRealmInputAttachments,
    validateRealmLaunchDraft,
    validateRealmV2InputDrafts,
    validateSeedDraft
  } from './realmLauncherHelpers.ts';
  import {
    buildRealmTemplateCatalogEntries,
    buildRealmTemplateExportFilename,
    describeRealmTemplateDeleteError,
    describeRealmTemplateDeletion,
    describeRealmTemplateExportError,
    describeRealmTemplateImportError,
    describeRealmTemplateImportReceipt,
    formatRealmLaunchTimestamp
  } from './realmTemplateHelpers.ts';
  import {
    assembleRealmAuthorityApprovals,
    buildRealmAgentDisclosureRows,
    buildRealmAuthorityDecisions,
    buildRealmAuthorityDecisionKey,
    buildRealmAuthorityReviewAgents,
    buildRealmHistoryEditorViews,
    buildRealmPartProvenanceViews,
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
  import { safeRealmColor } from './realmGroups.ts';

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

  // Template registry controls (Wave T): import a canonical bundle file,
  // export the effective bundle, delete an import (shipped revisions have no
  // delete path).
  let templateImportInput = $state(/** @type {HTMLInputElement | null} */(null));
  let payloadFileInput = $state(/** @type {HTMLInputElement | null} */(null));
  let isImporting = $state(false);
  let templateDeleteConfirming = $state(false);
  let templateDeletePlan = $derived(describeRealmTemplateDeletion(selectedTemplateEntry));

  // Catalog presets drive the per-agent preset-binding display (the store
  // resolves the actual launch binding from the same catalog).
  const presetCatalog = sandboxStore.getPresetCatalog();
  let catalogPresets = $state(presetCatalog.listPresets());
  let defaultPresetId = $state(presetCatalog.createPresetSourcePort().getDefaultPresetId());

  $effect(() => {
    const unsubscribe = presetCatalog.subscribe(() => {
      catalogPresets = presetCatalog.listPresets();
      defaultPresetId = presetCatalog.createPresetSourcePort().getDefaultPresetId();
    });
    return unsubscribe;
  });

  // Launch draft
  let realmName = $state('');
  let realmColor = $state('#7c9cff');
  let realmDescription = $state('');
  let inputDrafts = $state(/** @type {import('./realmLauncherHelpers.ts').RealmInputDraft[]} */([]));
  let inputErrors = $state(/** @type {Record<string, string>} */({}));
  // The files picker is shared: the draft id it targets is recorded on click.
  let inputFilesInput = $state(/** @type {HTMLInputElement | null} */(null));
  let activeFilesDraftId = $state('');

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
  let folderFilesInput = $state(/** @type {HTMLInputElement | null} */(null));
  let replaceFileInput = $state(/** @type {HTMLInputElement | null} */(null));
  let activeReplaceDraftId = $state('');
  let activeReplaceIndex = $state(-1);
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
    edits: fileEdits
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

  /**
   * Display value of one input for the review projections (effective text, or
   * the attached fileset's paths).
   *
   * @param {string} inputId - Declared input id.
   * @returns Display text.
   */
  function inputDisplayFor(inputId) {
    const value = reviewInputValues[inputId];
    if (!value) return '';
    return value.shape === 'text' ? value.text : value.files.map((file) => file.path).join(', ');
  }

  /** Review decisions for one declared pair (absent = declined). */
  function authorityDecision(agentKey, authority) {
    return authorityDecisions[buildRealmAuthorityDecisionKey(agentKey, authority)] ?? 'declined';
  }

  /** Whether one declared pair is checked (approved or trust-auto-approved). */
  function authorityChecked(agentKey, authority) {
    const decision = authorityDecision(agentKey, authority);
    return decision === 'approved' || decision === 'trusted';
  }

  /** Whether one declared pair renders locked by the template trust override. */
  function authorityTrusted(agentKey, authority) {
    return authorityDecision(agentKey, authority) === 'trusted';
  }

  /**
   * Resolves the source agent spec behind one preview row (the summary does
   * not carry `modelPresetId`).
   *
   * @param {string} key - Template agent key.
   * @returns {import('../../sandbox/realmCatalog/index.ts').RealmAgentSpec | null} Spec or null.
   */
  function agentSpecFor(key) {
    if (!selectedTemplate) return null;
    return selectedTemplate.agents.find((agent) => agent.key === key) ?? null;
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
    templateDeleteConfirming = false;
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
   * Resets the template-driven draft when the operator picks a template.
   *
   * The selected id is read from the event target (not the bound state) so
   * the draft always follows the operator's choice regardless of listener
   * ordering. Input drafts re-prefill from the newly selected template's
   * declared defaults; the seed toggle returns to its default-on position.
   *
   * @param {Event} [event] - Change event from the template select.
   */
  function handleTemplateChange(event) {
    clearMessages();
    const select = /** @type {HTMLSelectElement | null} */ (event ? event.currentTarget : null);
    applyTemplateSelection(select ? select.value : selectedTemplateId);
  }

  /**
   * Imports one canonical template bundle file into the store registry and
   * selects the imported template. Typed catalog/store failures (malformed
   * bundle, template validation, size budget, persistence rollback) are
   * surfaced inline; the picker re-resolves from the store on success.
   *
   * @param {Event} event - Change event of the hidden file input.
   */
  async function handleTemplateImport(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    clearMessages();
    isImporting = true;
    try {
      const payload = await file.text();
      const receipt = sandboxStore.importRealmTemplate(payload);
      catalogRevision += 1;
      applyTemplateSelection(receipt.templateId);
      notice = describeRealmTemplateImportReceipt(receipt);
    } catch (err) {
      validationError = describeRealmTemplateImportError(err);
    } finally {
      isImporting = false;
      if (input) input.value = '';
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
   * Deletes the selected imported template after an inline confirmation.
   * Deleting an import that shadowed a shipped id restores the shipped
   * revision in place; a failed persistence write rolls the delete back and
   * is surfaced inline.
   */
  function handleTemplateDelete() {
    const entry = selectedTemplateEntry;
    if (!entry || !templateDeletePlan.allowed) return;
    clearMessages();
    if (!templateDeleteConfirming) {
      templateDeleteConfirming = true;
      return;
    }
    const templateId = entry.id;
    const shadowed = entry.replacesShipped;
    try {
      sandboxStore.deleteRealmTemplate(templateId);
      catalogRevision += 1;
      templateDeleteConfirming = false;
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
      templateDeleteConfirming = false;
      validationError = describeRealmTemplateDeleteError(err);
    }
  }

  /**
   * Records one text field edit on a format-v2 draft (dirty presence
   * semantics) and clears its inline error.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft | null} draft - Edited draft.
   * @param {string} value - New field text.
   */
  function setInputValue(draft, value) {
    if (!draft || typeof draft.id !== 'string') return;
    inputDrafts = inputDrafts.map((entry) =>
      entry.id === draft.id ? setRealmV2InputText(entry, value) : entry
    );
    clearInputError(draft.id);
  }

  /**
   * Replaces the fileset of one files draft and clears its inline error.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft | null} draft - Edited draft.
   * @param {Array<{ path: string, content: string, name: string }>} files - New attachments.
   */
  function setInputFiles(draft, files) {
    if (!draft || typeof draft.id !== 'string') return;
    inputDrafts = inputDrafts.map((entry) =>
      entry.id === draft.id ? setRealmV2InputFiles(entry, files) : entry
    );
    clearInputError(draft.id);
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
   * Opens the shared file picker for one files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   */
  function openInputFilePicker(draft) {
    if (!draft || draft.shape !== 'files') return;
    activeFilesDraftId = draft.id;
    inputFilesInput?.click();
  }

  /**
   * Reads every picked file as a text attachment and appends it to the active
   * files draft: each attachment carries its own fileset-relative `path`
   * (the file name, made unique) so `path` selections and `root` joins resolve
   * deterministically.
   *
   * @param {Event} event - Change event of the shared file input.
   */
  async function handleInputFilesPick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const picked = input && input.files ? [...input.files] : [];
    const targetId = activeFilesDraftId;
    activeFilesDraftId = '';
    if (input) input.value = '';
    if (picked.length === 0 || !targetId) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files') return;
    try {
      const existing = draft.files.map((file) => file.path);
      const attachments = [];
      for (const file of picked) {
        const content = await file.text();
        const attachment = buildRealmInputAttachment(file.name, content);
        attachments.push({
          ...attachment,
          path: uniqueRealmAttachmentPath(
            [...existing, ...attachments.map((entry) => entry.path)],
            attachment.path
          )
        });
      }
      setInputFiles(draft, [...draft.files, ...attachments]);
    } catch (err) {
      validationError = err && err.message ? err.message : 'The attached files could not be read.';
    }
  }

  /**
   * Opens the shared directory picker for one files draft. The `webkitdirectory`
   * attribute is set imperatively so the template stays attribute-clean; picked
   * files keep their folder-relative paths.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   */
  function openInputFolderPicker(draft) {
    if (!draft || draft.shape !== 'files') return;
    if (folderFilesInput) folderFilesInput.setAttribute('webkitdirectory', '');
    activeFilesDraftId = draft.id;
    folderFilesInput?.click();
  }

  /**
   * Reads every file picked through the directory picker and appends it to the
   * active files draft, preserving each file's folder-relative path (made
   * unique); a picker that reports no relative path falls back to the file name.
   *
   * @param {Event} event - Change event of the hidden folder input.
   */
  async function handleFolderFilesPick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const picked = input && input.files ? [...input.files] : [];
    const targetId = activeFilesDraftId;
    activeFilesDraftId = '';
    if (input) input.value = '';
    if (picked.length === 0 || !targetId) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files') return;
    try {
      const existing = draft.files.map((file) => file.path);
      const attachments = [];
      for (const file of picked) {
        const content = await file.text();
        const relative = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
          ? file.webkitRelativePath
          : file.name;
        const attachment = buildRealmInputAttachment(relative, content);
        attachments.push({
          ...attachment,
          path: uniqueRealmAttachmentPath(
            [...existing, ...attachments.map((entry) => entry.path)],
            attachment.path
          )
        });
      }
      setInputFiles(draft, [...draft.files, ...attachments]);
    } catch (err) {
      validationError = err && err.message ? err.message : 'The attached folder could not be read.';
    }
  }

  /**
   * Opens the hidden single-file picker to replace one attachment in place: the
   * fileset path (the identity placements resolve against) is kept, only the
   * body and source name are swapped.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   * @param {number} index - Attachment index.
   */
  function openReplacementFilePicker(draft, index) {
    if (!draft || draft.shape !== 'files') return;
    activeFilesDraftId = draft.id;
    activeReplaceIndex = index;
    replaceFileInput?.click();
  }

  /**
   * Replaces the active attachment's body with the picked file (path preserved).
   *
   * @param {Event} event - Change event of the hidden replace input.
   */
  async function handleReplacementFilePick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    const targetId = activeFilesDraftId;
    const index = activeReplaceIndex;
    activeFilesDraftId = '';
    activeReplaceIndex = -1;
    if (input) input.value = '';
    if (!file || !targetId || index < 0) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files' || index >= draft.files.length) return;
    try {
      const content = await file.text();
      setInputFiles(draft, draft.files.map((entry, position) =>
        position === index ? { ...entry, content, name: file.name } : entry
      ));
    } catch (err) {
      validationError = err && err.message ? err.message : 'The replacement file could not be read.';
    }
  }

  /**
   * Updates one attachment's fileset path (the identity `path` selections and
   * `root` placements resolve against).
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   * @param {string} path - New fileset-relative path.
   */
  function setAttachmentPath(draft, index, path) {
    if (!draft || draft.shape !== 'files') return;
    setInputFiles(draft, draft.files.map((file, position) =>
      position === index ? { ...file, path } : file
    ));
  }

  /**
   * Updates one attachment's body text.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   * @param {string} content - New body.
   */
  function setAttachmentContent(draft, index, content) {
    if (!draft || draft.shape !== 'files') return;
    setInputFiles(draft, draft.files.map((file, position) =>
      position === index ? { ...file, content } : file
    ));
  }

  /**
   * Removes one attachment from a files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   */
  function removeAttachment(draft, index) {
    if (!draft || draft.shape !== 'files') return;
    setInputFiles(draft, draft.files.filter((_, position) => position !== index));
  }

  /**
   * Resolves the review draft behind one declared input id (history editing
   * renders an inline editor per referenced input).
   *
   * @param {string} inputId - Declared input id.
   * @returns The draft, or null when the input is not in the review form.
   */
  function draftFor(inputId) {
    return inputDrafts.find((draft) => draft.id === inputId) ?? null;
  }

  /**
   * Placement destinations of one input draft (root/path mapping rendered by
   * the fileset editor).
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Input draft.
   * @returns Derived placement destinations.
   */
  function placementDestinationsFor(draft) {
    return buildRealmInputPlacementDestinations(draft ? draft.usage : null);
  }

  /**
   * Per-file attachment rows (size + resolved placement destinations) of one
   * files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Input draft.
   * @returns Per-file attachment views.
   */
  function attachmentViewsFor(draft) {
    if (!draft || draft.shape !== 'files') return [];
    return buildRealmFileAttachmentViews(draft, placementDestinationsFor(draft));
  }

  /**
   * Display destination of one placement: a `path` writes its declared path, a
   * `root` renders the prefix with a `<file path>` join marker.
   *
   * @param {import('./realmHydrationHelpers.ts').RealmInputPlacementDestination} placement - Placement destination.
   * @returns Display text.
   */
  function placementPreview(placement) {
    if (!placement || typeof placement.destination !== 'string') return '';
    if (placement.mode !== 'root') return placement.destination;
    const prefix = placement.destination.endsWith('/') ? placement.destination : `${placement.destination}/`;
    return `${prefix}<file path>`;
  }

  /**
   * Counts editable history entries in one editor projection (the template
   * summary cannot host an arrow-function expression).
   *
   * @param {import('./realmReviewHelpers.ts').RealmHistoryEditorProjection} projection - History projection.
   * @returns Number of entries with at least one source-editable part.
   */
  function countEditableHistoryEntries(projection) {
    return (projection?.entries ?? []).filter((entry) => entry.editable).length;
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
  function resetInputDraft(draft) {
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

  function addSeedRow() {
    seedRows = [...seedRows, { path: '', content: '' }];
    clearMessages();
  }

  // ---- Wave U review handlers (ticket 458e727) ----------------------------

  /**
   * Switches the payload attachment source (`none` / `candidate` / `file`).
   * Switching away from a candidate/file detaches the current payload; the
   * review acknowledgement is re-armed because the attached content changed.
   *
   * @param {Event} event - Change event from the payload source select.
   */
  function handlePayloadSourceChange(event) {
    const select = /** @type {HTMLSelectElement | null} */ (event ? event.currentTarget : null);
    const value = select ? select.value : 'none';
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
   * @param {Event} event - Change event of the hidden payload file input.
   */
  async function handlePayloadFilePick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
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
    } finally {
      if (input) input.value = '';
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
   * @param {Event} event - Change event of the trust checkbox.
   */
  function handleTrustToggle(event) {
    const input = /** @type {HTMLInputElement | null} */ (event ? event.currentTarget : null);
    trustTemplate = input ? input.checked : false;
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
   * @param {Event} event - Change event of the mismatch confirmation checkbox.
   */
  function handleMismatchConfirm(event) {
    const input = /** @type {HTMLInputElement | null} */ (event ? event.currentTarget : null);
    mismatchConfirmed = input ? input.checked : false;
    reviewAcknowledged = false;
    clearMessages();
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
        <div class="form-group">
          <label for="realm-template-select">Template <span class="req">*</span></label>
          <div class="template-picker-row">
            <select
              id="realm-template-select"
              bind:value={selectedTemplateId}
              onchange={handleTemplateChange}
              class="select-field"
            >
              <option value="">Select a template…</option>
              {#each catalogEntries as entry (entry.id)}
                <option value={entry.id}>{entry.name} — {entry.sourceLabel}</option>
              {/each}
            </select>
            <div class="template-picker-actions">
              <button
                type="button"
                class="btn-secondary btn-xs"
                onclick={() => templateImportInput?.click()}
                disabled={isImporting}
              >
                {isImporting ? 'Importing…' : 'Import…'}
              </button>
              <button
                type="button"
                class="btn-secondary btn-xs"
                onclick={handleTemplateExport}
                disabled={!selectedTemplate}
              >
                Export
              </button>
            </div>
          </div>
          <input
            bind:this={templateImportInput}
            class="visually-hidden"
            type="file"
            accept="application/json,.json"
            aria-label="Import realm template bundle"
            onchange={handleTemplateImport}
          />
          {#if selectedTemplateEntry}
            <span class="template-source-line">
              Source:
              <span class="source-badge" class:source-imported={selectedTemplateEntry.source === 'imported'}>
                {selectedTemplateEntry.sourceLabel}
              </span>
              {#if selectedTemplateEntry.templateVersion}
                <span class="template-version font-mono">{selectedTemplateEntry.templateVersion}</span>
              {/if}
            </span>
          {/if}
          {#if selectedTemplate}
            <span class="field-hint">{selectedTemplate.description}</span>
          {:else}
            <span class="field-hint">
              Shipped templates ship with the sandbox; import a canonical bundle JSON to add your own. The agent
              preview appears once one is selected.
            </span>
          {/if}
          {#if selectedTemplateEntry && selectedTemplateEntry.deletable}
            {#if templateDeleteConfirming}
              <div class="template-delete-confirm">
                <p class="template-delete-copy">{templateDeletePlan.confirmCopy}</p>
                <div class="template-picker-actions">
                  <button type="button" class="btn-secondary btn-xs" onclick={() => templateDeleteConfirming = false}>
                    Cancel
                  </button>
                  <button type="button" class="btn-danger btn-xs" onclick={handleTemplateDelete}>
                    {templateDeletePlan.confirmLabel}
                  </button>
                </div>
              </div>
            {:else}
              <div class="template-picker-actions">
                <button type="button" class="btn-danger-outline btn-xs" onclick={handleTemplateDelete}>
                  Delete Import…
                </button>
              </div>
            {/if}
          {/if}
        </div>

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

          {#if inputDrafts.length > 0}
            <div class="settings-section-card">
              <div class="section-card-header">
                <div class="section-title-wrap">
                  <span class="section-badge">Inputs</span>
                  <h4 class="section-title">Hydration workspace — inputs ({inputDrafts.length})</h4>
                </div>
              </div>
              <p class="field-hint">
                Launch-level values shared by every member that references them. An untouched field keeps the
                attached payload's value, then the template default; an edited field is sent explicitly (clearing a
                required field blocks the launch). Files inputs carry one or more attached files (or a whole folder),
                each with its own fileset-relative path and root-mapped placement destinations.
              </p>
              <input
                bind:this={inputFilesInput}
                class="visually-hidden"
                type="file"
                multiple
                aria-label="Attach files to the selected template input"
                onchange={handleInputFilesPick}
              />
              <input
                bind:this={folderFilesInput}
                class="visually-hidden"
                type="file"
                multiple
                aria-label="Attach a folder to the selected template input"
                onchange={handleFolderFilesPick}
              />
              <input
                bind:this={replaceFileInput}
                class="visually-hidden"
                type="file"
                aria-label="Replace the selected attached file"
                onchange={handleReplacementFilePick}
              />
              {#each inputDrafts as draft (draft.id)}
                <div class="form-group">
                  <label for={`realm-input-${draft.id}`}>
                    {draft.label}{#if draft.required}<span class="req"> *</span>{/if}
                    <span class="shape-badge">{draft.shape === 'files' ? 'files' : 'text'}</span>
                  </label>
                  {#if draft.shape === 'files'}
                    <div class="fileset-field">
                      <div class="input-actions">
                        <button type="button" class="btn-secondary btn-xs" onclick={() => openInputFilePicker(draft)}>
                          Attach files…
                        </button>
                        <button type="button" class="btn-secondary btn-xs" onclick={() => openInputFolderPicker(draft)}>
                          Attach folder…
                        </button>
                        {#if draft.files.length > 0}
                          <span class="input-dirty-note">
                            {draft.files.length} file{draft.files.length === 1 ? '' : 's'} attached
                          </span>
                        {/if}
                      </div>
                      {#if draft.files.length === 0}
                        <span class="field-hint">No files attached — an absent optional fileset writes nothing.</span>
                      {/if}
                      {#if placementDestinationsFor(draft).length > 0}
                        <ul class="placement-map">
                          {#each placementDestinationsFor(draft) as placement, placementIndex (placementIndex)}
                            <li class="placement-row">
                              <span class="placement-mode">{placement.mode === 'root' ? 'root' : 'path'}</span>
                              <span class="placement-target">{placement.targetLabel}</span>
                              <span class="placement-destination font-mono">
                                {placementPreview(placement)}
                              </span>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                      {#each attachmentViewsFor(draft) as view (view.index)}
                        <div class="attachment-row">
                          <div class="attachment-head">
                            <input
                              type="text"
                              class="input-field font-mono"
                              value={draft.files[view.index].path}
                              aria-label={`Attachment ${view.index + 1} fileset path`}
                              oninput={(event) => setAttachmentPath(draft, view.index, event.currentTarget.value)}
                            />
                            <button
                              type="button"
                              class="btn-secondary btn-xs"
                              onclick={() => openReplacementFilePicker(draft, view.index)}
                              aria-label={`Replace attachment ${view.index + 1}`}
                            >
                              Replace…
                            </button>
                            <button
                              type="button"
                              class="btn-row-remove"
                              onclick={() => removeAttachment(draft, view.index)}
                              aria-label={`Remove attachment ${view.index + 1}`}
                            >
                              Remove
                            </button>
                          </div>
                          <span class="field-hint">
                            {view.sizeLabel}{view.name ? ` · from ${view.name}` : ' · typed fileset path'}
                          </span>
                          {#if view.destinations.length > 0}
                            <span class="field-hint attachment-destinations">
                              Writes:
                              {#each view.destinations as destination, destinationIndex (destinationIndex)}
                                <span class="font-mono">{destination}</span>{destinationIndex < view.destinations.length - 1 ? ', ' : ''}
                              {/each}
                            </span>
                          {/if}
                          <details class="attachment-content">
                            <summary>Content ({draft.files[view.index].content.length} chars)</summary>
                            <textarea
                              rows="3"
                              class="textarea-field font-mono"
                              value={draft.files[view.index].content}
                              aria-label={`Attachment ${view.index + 1} content`}
                              oninput={(event) => setAttachmentContent(draft, view.index, event.currentTarget.value)}
                            ></textarea>
                          </details>
                        </div>
                      {/each}
                    </div>
                  {:else if draft.multiline}
                    <textarea
                      id={`realm-input-${draft.id}`}
                      value={inputDisplayFor(draft.id)}
                      rows="3"
                      class="textarea-field"
                      disabled={!isRealmV2InputEditable(draft)}
                      oninput={(event) => setInputValue(draft, event.currentTarget.value)}
                    ></textarea>
                  {:else}
                    <input
                      id={`realm-input-${draft.id}`}
                      type="text"
                      value={inputDisplayFor(draft.id)}
                      class="input-field"
                      disabled={!isRealmV2InputEditable(draft)}
                      oninput={(event) => setInputValue(draft, event.currentTarget.value)}
                    />
                  {/if}
                  {#if !draft.dirty && payloadInputIds.has(draft.id)}
                    <span class="field-hint payload-input-note">
                      Attached payload value — edit the field to override it explicitly.
                    </span>
                  {/if}
                  {#if draft.brief}
                    <span class="field-hint hydration-brief">Brief: {draft.brief}</span>
                  {/if}
                  {#if draft.help}
                    <span class="field-hint">{draft.help}</span>
                  {/if}
                  {#if draft.shape === 'text' && !draft.defaultResolved}
                    <span class="field-hint input-warning">
                      The template's default file is not in the launch bundle — the field starts empty.
                    </span>
                  {/if}
                  <div class="input-actions">
                    <button type="button" class="btn-secondary btn-xs" onclick={() => resetInputDraft(draft)}>
                      {draft.shape === 'files' ? 'Clear attached files' : 'Reset to template default'}
                    </button>
                    {#if draft.dirty}
                      <span class="input-dirty-note">Edited — sent explicitly at launch.</span>
                    {/if}
                  </div>
                  <div class="usage-map">
                    <span class="usage-summary">Usage: {draft.usage.summary}</span>
                    {#if draft.usage.sites.length > 0}
                      <ul class="usage-list">
                        {#each draft.usage.sites as site, index (index)}
                          <li class="usage-row">
                            <span class="usage-kind">{site.kind}</span>
                            <span class="usage-label">{site.label}</span>
                            {#if site.path}
                              <span class="usage-path font-mono">{site.path}</span>
                            {/if}
                            <span class="usage-detail">{site.detail}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                  {#if inputErrors[draft.id]}
                    <span class="input-error" role="alert">{inputErrors[draft.id]}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if selectedTemplate}
            <div class="settings-section-card">
              <div class="section-card-header">
                <div class="section-title-wrap">
                  <span class="section-badge">Payload</span>
                  <h4 class="section-title">Instance payload (attach at launch)</h4>
                </div>
                {#if attachedPayload}
                  <span class="payload-attached-badge">attached</span>
                {/if}
              </div>
              <p class="field-hint">
                The reviewed instance content: declared input values (<code>text</code> or <code>files</code>
                shape). Attach a submitted session candidate, a named payload from the session library, or a local
                <code>{buildRealmPayloadFilename(selectedTemplateId)}</code> file. The package is validated against
                the effective template version before any launch; candidates and saved payloads are session-only.
                Edited input values win per input over the attached package.
              </p>
              <div class="payload-source-row">
                <select
                  class="select-field"
                  value={payloadSourceKind}
                  onchange={handlePayloadSourceChange}
                  aria-label="Payload attachment source"
                >
                  <option value="none">No payload attached</option>
                  <option value="candidate" disabled={pendingPayloads.length === 0}>Submitted candidate…</option>
                  <option value="saved" disabled={savedPayloads.length === 0}>Saved payload…</option>
                  <option value="file">Local payload file…</option>
                </select>
                {#if payloadSourceKind === 'file'}
                  <button type="button" class="btn-secondary btn-xs" onclick={() => payloadFileInput?.click()}>
                    Choose file…
                  </button>
                {/if}
                {#if attachedPayload}
                  <button type="button" class="btn-danger-outline btn-xs" onclick={detachPayload}>Detach</button>
                {/if}
              </div>
              <input
                bind:this={payloadFileInput}
                class="visually-hidden"
                type="file"
                accept="application/json,.json"
                aria-label="Attach instance payload file"
                onchange={handlePayloadFilePick}
              />

              {#if payloadSourceKind === 'candidate'}
                {#if pendingPayloads.length === 0}
                  <p class="payload-status payload-empty">
                    No session candidates are pending for this template — submit one with the hydration tool, or
                    attach a saved or local payload.
                  </p>
                {:else}
                  {#each pendingPayloads as candidate (candidate.templateId)}
                    <div class="payload-candidate">
                      <div class="payload-candidate-info">
                        <span class="payload-candidate-title font-mono">{candidate.templateVersion}</span>
                        <span class="field-hint">{candidate.summary}</span>
                      </div>
                      <div class="template-picker-actions">
                        <button
                          type="button"
                          class="btn-secondary btn-xs"
                          class:active-candidate={payloadCandidateId === candidate.templateId && Boolean(attachedPayload)}
                          onclick={() => attachPayloadCandidate(candidate)}
                        >
                          {payloadCandidateId === candidate.templateId && attachedPayload ? 'Attached' : 'Attach'}
                        </button>
                        <button type="button" class="btn-secondary btn-xs" onclick={() => downloadPayloadCandidate(candidate)}>
                          Download
                        </button>
                        <button type="button" class="btn-danger-outline btn-xs" onclick={() => clearPayloadCandidate(candidate)}>
                          Clear…
                        </button>
                      </div>
                    </div>
                  {/each}
                {/if}
              {/if}

              {#if payloadSourceKind === 'saved'}
                {#if savedPayloads.length === 0}
                  <p class="payload-status payload-empty">
                    No saved payloads exist for this template yet — assemble inputs and save one below, or attach a
                    local payload file.
                  </p>
                {:else}
                  {#each savedPayloads as entry (entry.id)}
                    <div class="payload-candidate">
                      <div class="payload-candidate-info">
                        <span class="payload-candidate-title">
                          {entry.name}
                          <span class="template-version font-mono">{entry.digest}</span>
                        </span>
                        <span class="field-hint">{entry.inputSummary} · saved {formatRealmLaunchTimestamp(entry.savedAt)}</span>
                      </div>
                      <div class="template-picker-actions">
                        <button
                          type="button"
                          class="btn-secondary btn-xs"
                          class:active-candidate={payloadSavedId === entry.id && Boolean(attachedPayload)}
                          onclick={() => attachSavedPayload(entry)}
                        >
                          {payloadSavedId === entry.id && attachedPayload ? 'Attached' : 'Attach'}
                        </button>
                        <button type="button" class="btn-secondary btn-xs" onclick={() => downloadSavedPayload(entry)}>
                          Download
                        </button>
                        <button type="button" class="btn-danger-outline btn-xs" onclick={() => deleteSavedPayload(entry)}>
                          Delete…
                        </button>
                      </div>
                    </div>
                  {/each}
                {/if}
              {/if}

              {#if payloadFileError}
                <p class="payload-error" role="alert">{payloadFileError}</p>
              {/if}
              {#if attachedPayload}
                <p class="payload-status">
                  Attached: {payloadSourceLabel}{#if payloadPreview.mismatch} — pins a different template version
                  (current {effectiveBundleVersion ?? 'unknown'}){/if}.
                </p>
                {#if payloadPreview.mismatch}
                  <label class="seed-toggle">
                    <input type="checkbox" checked={mismatchConfirmed} onchange={handleMismatchConfirm} />
                    <span>Allow the template-version mismatch for this payload</span>
                  </label>
                {/if}
              {:else if payloadSourceKind === 'file'}
                <p class="payload-status">No payload file read yet — choose a package JSON file.</p>
              {/if}
              {#if editedFileSlotCount > 0}
                <p class="payload-status">
                  {editedFileSlotCount} reviewed file slot{editedFileSlotCount === 1 ? '' : 's'} assembled into the
                  launch package.
                </p>
              {/if}

              <div class="save-payload-row">
                <input
                  type="text"
                  class="input-field grow"
                  placeholder="Name this payload (e.g. Act 1 briefs)"
                  aria-label="Saved payload name"
                  bind:value={savedPayloadName}
                  oninput={() => savedPayloadError = ''}
                />
                <button type="button" class="btn-secondary btn-xs" onclick={saveCurrentPayload}>
                  Save payload…
                </button>
              </div>
              {#if savedPayloadError}
                <p class="payload-error" role="alert">{savedPayloadError}</p>
              {/if}

              <div class="pin-card">
                <div class="pin-row">
                  <span class="pin-label">Template pin</span>
                  <span class="pin-value font-mono">{hydrationPinView.pin || 'unresolved'}</span>
                </div>
                <div class="pin-row">
                  <span class="pin-label">Payload digest</span>
                  <span class="pin-value font-mono" class:pin-value-missing={!hydrationPinView.digestOk}>
                    {hydrationPinView.digestOk ? hydrationPinView.digest : (hydrationPinView.digestError || 'no payload')}
                  </span>
                </div>
                <div class="pin-row">
                  <span class="pin-label">Content</span>
                  <span class="pin-value">
                    {hydrationPinView.sourceLabel} · {hydrationPinView.inputCount} input{hydrationPinView.inputCount === 1 ? '' : 's'}{#if hydrationPinView.fileCount > 0} · {hydrationPinView.fileCount} file{hydrationPinView.fileCount === 1 ? '' : 's'}{/if}
                  </span>
                </div>
              </div>
            </div>
          {/if}

          {#if seedSummary.declaresSeed}
            <div class="settings-section-card">
              <div class="section-card-header">
                <div class="section-title-wrap">
                  <span class="section-badge">Seed</span>
                  <h4 class="section-title">Template seed</h4>
                </div>
              </div>
              <p class="seed-summary-line">
                {seedSummary.placementCount ?? seedSummary.fileCount}
                placement{(seedSummary.placementCount ?? seedSummary.fileCount) === 1 ? '' : 's'} write at launch into
                {seedSummary.targetLabels.length > 0 ? seedSummary.targetLabels.join(', ') : 'no target'}{#if seedSummary.directiveCount} · {seedSummary.directiveCount} directive{seedSummary.directiveCount === 1 ? '' : 's'}{/if}.
              </p>
              {#if directiveReview.entries.length > 0}
                <div class="directive-review">
                  <span class="slot-list-title">Directives ({directiveReview.entries.length})</span>
                  {#each directiveReview.entries as entry, index (index)}
                    <div class="directive-row">
                      <span class="directive-target">
                        → {entry.targetLabel}
                        {#if entry.source === 'input'}
                          <span class="field-hint">bound to "{entry.inputLabel}"</span>
                        {:else}
                          <span class="field-hint">literal directive</span>
                        {/if}
                      </span>
                      {#if entry.error}
                        <span class="input-error" role="alert">{entry.error}</span>
                      {:else if entry.text}
                        <span class="seed-directive-preview">“{entry.text}”</span>
                      {:else}
                        <span class="field-hint">resolves empty — this directive delivers nothing.</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else if seedSummary.directive}
                <p class="seed-summary-line">
                  First directive → {seedSummary.directive.targetLabel}:
                  <span class="seed-directive-preview">“{seedSummary.directive.preview}”</span>
                </p>
              {/if}
              {#if fileSlots.length > 0}
                <div class="slot-list">
                  <span class="slot-list-title">
                    Destinations ({fileSlots.length}){#if editedFileSlotCount > 0} · {editedFileSlotCount} edited{/if}{#if conflictedFileSlotCount > 0} · {conflictedFileSlotCount} conflict{conflictedFileSlotCount === 1 ? '' : 's'}{/if}{#if attachedPayload} · payload attached{/if}
                  </span>
                  <div class="template-picker-actions">
                    <button type="button" class="btn-secondary btn-xs" onclick={openFilesDialog}>
                      Review file contents…
                    </button>
                  </div>
                  <span class="field-hint">
                    Every declared placement with its resolved content. Bundle-file destinations ship in the bundle;
                    input destinations resolve from the launch inputs (then the attached payload) and are edited at
                    the input field above.
                  </span>
                </div>
              {/if}
              <label class="seed-toggle">
                <input type="checkbox" bind:checked={seedAfterLaunch} />
                <span>Seed after launch</span>
              </label>
              <span class="field-hint">
                On by default. Turn it off to launch without the template seed and seed manually afterwards.
              </span>
              {#if attachedPayload && !seedAfterLaunch}
                <span class="field-hint payload-input-note">
                  Seeding is off — the attached payload's file content will not be written at launch.
                </span>
              {/if}
            </div>
          {/if}

          <div class="settings-section-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge">Preview</span>
                <h4 class="section-title">Agents ({preview.rows.length})</h4>
              </div>
            </div>

            {#each preview.rows as row (row.key)}
              {@const spec = agentSpecFor(row.key)}
              {@const binding = describeRealmPresetBinding(spec?.modelPresetId, catalogPresets, defaultPresetId)}
              {@const promptPreview = buildRealmPromptPreview(spec?.prompt ?? [], selectedTemplate?.inputs, { inputs: reviewInputValues, bundleFiles })}
              {@const promptPartViews = buildRealmPartProvenanceViews(spec?.prompt ?? [], selectedTemplate?.inputs, { inputs: reviewInputValues, bundleFiles })}
              {@const historyEditor = buildRealmHistoryEditorViews(spec, selectedTemplate?.inputs, { inputs: reviewInputValues, bundleFiles })}
              {@const disclosureRows = buildRealmAgentDisclosureRows(spec, binding.label)}
              <div class="agent-preview-card">
                <div class="agent-preview-head">
                  <div class="agent-preview-identity">
                    <span class="agent-preview-name">{row.name}</span>
                    <span class="agent-preview-id font-mono">{row.idPattern}</span>
                  </div>
                  <div class="agent-preview-badges">
                    {#if row.privileged}
                      <span class="badge badge-sudo" title="Universal Administrative / Sudo Authority">⚡ sudo</span>
                    {:else}
                      <span class="badge badge-muted">unprivileged</span>
                    {/if}
                    {#if row.wildcard}
                      <span class="badge badge-wildcard" title="Effective grants include the wildcard '*'">
                        * wildcard{row.wildcardSource === 'privileged' ? ' · from privilege' : ''}
                      </span>
                    {/if}
                    {#if spec && Array.isArray(spec.authorities) && spec.authorities.length > 0}
                      <span class="badge badge-authority" title="Declared publishing-authority requests; approved per launch below">
                        {spec.authorities.length} declared authorit{spec.authorities.length === 1 ? 'y' : 'ies'}
                      </span>
                    {/if}
                  </div>
                </div>
                <p class="agent-preview-role">{row.role}</p>
                <div class="agent-preview-meta">
                  <div class="meta-line">
                    <span class="meta-label">Preset</span>
                    <span class="meta-value font-mono">{row.preset ?? 'custom list'}</span>
                  </div>
                  <div class="meta-line">
                    <span class="meta-label">Model binding</span>
                    <span class="meta-value font-mono">
                      {binding.label}{binding.isDefault ? ' · active default' : ''}{binding.known ? '' : ' ⚠'}
                    </span>
                  </div>
                </div>

                <div class="disclosure-grid">
                  {#each disclosureRows as disclosure (disclosure.key)}
                    <div class="meta-line disclosure-line">
                      <span class="meta-label">{disclosure.label}</span>
                      <span class="meta-value disclosure-value" class:disclosure-empty={!disclosure.present}>
                        {disclosure.value}
                      </span>
                    </div>
                  {/each}
                </div>

                {#if row.unrecognized.length > 0}
                  <p class="unrecognized-note">
                    Unrecognized grants: {row.unrecognized.join(', ')}
                  </p>
                {/if}

                <div class="grant-groups">
                  <details class="grant-details">
                    <summary>Mutating tools ({row.mutating.length})</summary>
                    <div class="chip-wrap">
                      {#each row.mutating as tool (tool)}
                        <span class="tool-chip mutating font-mono">{tool}</span>
                      {/each}
                    </div>
                  </details>
                  <details class="grant-details">
                    <summary>Read-only tools ({row.readOnly.length})</summary>
                    <div class="chip-wrap">
                      {#each row.readOnly as tool (tool)}
                        <span class="tool-chip readonly font-mono">{tool}</span>
                      {/each}
                    </div>
                  </details>
                </div>
                {#if row.wildcard}
                  <p class="grant-note">
                    Wildcard capability: the classification above covers the full canonical tool vocabulary
                    ({row.mutating.length} mutating, {row.readOnly.length} read-only).
                  </p>
                {/if}

                <details class="prompt-preview">
                  <summary>Composed prompt preview — {promptPartViews.parts.length} parts</summary>
                  {#if promptPreview.ok}
                    <pre class="prompt-preview-text">{promptPreview.systemPrompt}</pre>
                    {#if promptPartViews.ok && promptPartViews.parts.length > 0}
                      <ul class="part-list">
                        {#each promptPartViews.parts as part (part.index)}
                          <li class="part-row">
                            <span class="part-origin" class:origin-fixed={part.origin === 'fixed'} class:origin-user={part.origin === 'user'} class:origin-generated={part.origin === 'generated'}>
                              {part.origin}
                            </span>
                            <span class="part-label">{part.label}</span>
                            {#if part.editable}
                              <span class="part-note">editable at source</span>
                            {/if}
                            {#if part.empty}
                              <span class="part-note part-note-empty">contributes nothing</span>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    {#if promptPreview.inputProvenance.length > 0}
                      <p class="prompt-preview-note">
                        Inputs referenced:
                        {promptPreview.inputProvenance.map((entry) => `${entry.inputId} (${entry.source})`).join(', ')}.
                      </p>
                    {/if}
                  {:else if promptPreview.bundleUnavailable}
                    <p class="prompt-preview-note prompt-preview-missing">
                      Bundle not available — {promptPreview.error}
                    </p>
                  {:else}
                    <p class="prompt-preview-note prompt-preview-missing">{promptPreview.error}</p>
                  {/if}
                </details>

                <details class="prompt-preview history-preview">
                  <summary>
                    Baked history ({historyEditor.entries.length}){#if countEditableHistoryEntries(historyEditor) > 0} — editable at source{:else} — fixed{/if}
                  </summary>
                  {#if historyEditor.ok}
                    {#if historyEditor.entries.length === 0}
                      <p class="prompt-preview-note">No baked history is declared for this agent.</p>
                    {:else}
                      {#each historyEditor.entries as entry (entry.index)}
                        <div class="history-entry">
                          <span class="history-role" class:role-agent={entry.role === 'assistant'}>
                            {entry.roleLabel}
                          </span>
                          <pre class="history-content">{entry.content}</pre>
                          {#if entry.parts.length > 0}
                            <ul class="part-list">
                              {#each entry.parts as part (part.index)}
                                <li class="part-row">
                                  <span class="part-origin" class:origin-fixed={part.origin === 'fixed'} class:origin-user={part.origin === 'user'} class:origin-generated={part.origin === 'generated'}>
                                    {part.origin}
                                  </span>
                                  <span class="part-label">{part.label}</span>
                                  {#if part.editable && draftFor(part.inputId)?.shape === 'text'}
                                    <textarea
                                      class="part-input-edit"
                                      rows="2"
                                      value={inputDisplayFor(part.inputId)}
                                      aria-label={`Edit ${part.inputLabel} for this history entry`}
                                      oninput={(event) => setInputValue(draftFor(part.inputId), event.currentTarget.value)}
                                    ></textarea>
                                    <span class="part-note">edits the launch input (source)</span>
                                  {:else if part.editable && draftFor(part.inputId)?.shape === 'files'}
                                    <span class="part-note">files input — edit the attached fileset above</span>
                                  {:else if part.editable}
                                    <span class="part-note">input not declared in the review form</span>
                                  {:else}
                                    <span class="part-note">shipped in the bundle</span>
                                  {/if}
                                </li>
                              {/each}
                            </ul>
                          {/if}
                        </div>
                      {/each}
                    {/if}
                  {:else if historyEditor.bundleUnavailable}
                    <p class="prompt-preview-note prompt-preview-missing">
                      Bundle not available — {historyEditor.error}
                    </p>
                  {:else}
                    <p class="prompt-preview-note prompt-preview-missing">{historyEditor.error}</p>
                  {/if}
                </details>
              </div>
            {/each}
          </div>

          {#if authorityAgents.length > 0}
            <div class="settings-section-card">
              <div class="section-card-header">
                <div class="section-title-wrap">
                  <span class="section-badge">Authorities</span>
                  <h4 class="section-title">Declared publishing authorities</h4>
                </div>
                {#if trustView.trusted}
                  <span class="trust-badge">trusted</span>
                {/if}
              </div>
              <p class="field-hint">
                Publishing is an explicit operator grant — never implied by privilege or the wildcard. Check a request
                to approve it for this launch; unchecked requests are declined and the launched agent simply lacks the
                authority. Approved grants are ordinary revocable operator grants.
              </p>
              {#if unknownAuthorities.length > 0}
                <p class="payload-error" role="alert">
                  Unknown declared authorit{unknownAuthorities.length === 1 ? 'y' : 'ies'}:
                  {unknownAuthorities.join(', ')} — this host cannot enforce
                  {unknownAuthorities.length === 1 ? 'it' : 'them'}, so the launch fails closed.
                </p>
              {/if}
              {#each authorityAgents as row (row.key)}
                <div class="authority-agent">
                  <div class="authority-agent-head">
                    <span class="authority-agent-name">{row.name}</span>
                    <span class="authority-agent-key font-mono">{row.key}</span>
                    {#if row.privileged}
                      <span class="badge badge-sudo" title="Privilege is disclosed separately and never implies these authorities">⚡ sudo</span>
                    {/if}
                  </div>
                  {#each row.declarations as declaration (declaration.authority)}
                    <label
                      class="authority-row"
                      class:authority-row-trusted={authorityTrusted(row.key, declaration.authority)}
                    >
                      <input
                        type="checkbox"
                        checked={authorityChecked(row.key, declaration.authority)}
                        disabled={authorityTrusted(row.key, declaration.authority) || !declaration.known}
                        onchange={(event) => setAuthorityDecision(row.key, declaration.authority, event.currentTarget.checked)}
                      />
                      <div class="authority-info">
                        <div class="authority-title-row">
                          <span class="authority-title font-mono">{declaration.authority}</span>
                          <span class="authority-label">{declaration.label}</span>
                          {#if authorityTrusted(row.key, declaration.authority)}
                            <span class="trust-badge">trust-auto-approved</span>
                          {/if}
                          {#if !declaration.known}
                            <span class="unknown-badge">unknown to this host</span>
                          {/if}
                        </div>
                        <span class="policy-desc">{declaration.description}</span>
                      </div>
                    </label>
                  {/each}
                </div>
              {/each}

              <div class="trust-control">
                {#if trustView.trusted}
                  <p class="payload-status">{trustView.summary}</p>
                  {#if trustView.pairs.length > 0}
                    <ul class="written-paths">
                      {#each trustView.pairs as pair (`${pair.agentKey}::${pair.authority}`)}
                        <li class="font-mono">{pair.agentKey} → {pair.authority}</li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="template-picker-actions">
                    <button type="button" class="btn-danger-outline btn-xs" onclick={clearTemplateTrust}>
                      Clear trust override
                    </button>
                  </div>
                {:else}
                  <p class="field-hint">No trust override is stored for this template.</p>
                {/if}
                <label class="seed-toggle">
                  <input type="checkbox" checked={trustTemplate} onchange={handleTrustToggle} />
                  <span>Trust this template for these exact approvals (persisted on a successful launch)</span>
                </label>
                <span class="field-hint">
                  Trust auto-approves only the exact (agent, authority) set approved now; a newly declared authority
                  re-prompts, and clearing the override revokes it (already-applied grants stay revocable through the
                  agent settings toggles).
                </span>
              </div>
            </div>
          {/if}
        {/if}

        {#if selectedTemplate}
          <div class="review-gate">
            <label class="review-ack">
              <input type="checkbox" checked={reviewAcknowledged} onchange={handleReviewAcknowledge} />
              <span>
                I reviewed the composed prompts, the resolved input values and file contents, and the declared
                publishing authorities for this launch.
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
      {#if launchReceipt}
        <div class="launch-receipt" role="status">
          <div class="receipt-title-row">
            <span class="badge badge-success">Launched</span>
            <span class="receipt-title">{launchReceipt.realm.name}</span>
            <span class="receipt-id font-mono">{launchReceipt.realm.id}</span>
          </div>
          <p class="receipt-copy">
            {launchReceipt.agents.length} member{launchReceipt.agents.length === 1 ? '' : 's'} launched and grouped in the
            sidebar: {launchReceipt.agents.map((agent) => agent.name).join(', ')}.
          </p>
          {#if launchApprovals.length > 0}
            <p class="receipt-copy">
              Approved publishing authorities: {launchApprovals.map((entry) => `${entry.agentKey} → ${entry.authority}`).join(', ')}.
            </p>
          {/if}
        </div>

        {#if seedReceipt}
          <div class="settings-section-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge">Seed</span>
                <h4 class="section-title">Seed receipt</h4>
              </div>
            </div>
            <p class="receipt-copy">
              Wrote {seedReceipt.writtenPaths.length} file{seedReceipt.writtenPaths.length === 1 ? '' : 's'} into
              {describeSeedWorkspace(seedReceipt.workspace, seedReceipt.realmId)}.
            </p>
            <ul class="written-paths">
              {#each seedReceipt.writtenPaths as path (path)}
                <li class="font-mono">{path}</li>
              {/each}
            </ul>
            <p class="receipt-copy">
              {#if seedReceipt.directiveDelivered}
                Directive delivered to the target member's mailbox (operator-attributed).
              {:else if seedDirectiveRequested}
                Directive was NOT delivered — no operator principal may be registered.
              {:else}
                No directive was requested.
              {/if}
            </p>
          </div>
          <div class="modal-footer compact">
            <button type="button" class="btn-primary" onclick={() => onclose()}>Done</button>
          </div>
        {:else}
          <form class="launcher-form" onsubmit={handleSeed} novalidate>
            <div class="settings-section-card">
              <div class="section-card-header">
                <div class="section-title-wrap">
                  <span class="section-badge">Seed</span>
                  <h4 class="section-title">Optional post-launch seed</h4>
                </div>
              </div>

              <div class="form-group">
                <label for="realm-seed-target">Target workspace</label>
                <select id="realm-seed-target" bind:value={seedTargetId} class="select-field" onchange={clearMessages}>
                  {#each seedTargetOptions as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
                <span class="field-hint">
                  Files land in the Realm-global workspace by default, or in the selected member's private workspace.
                  A directive needs a member recipient.
                </span>
              </div>

              <div class="form-group">
                <span class="label-text">Files</span>
                {#if seedRows.length === 0}
                  <p class="rows-empty">No file rows yet — add one to seed, or skip seeding.</p>
                {/if}
                {#each seedRows as row, index (index)}
                  <div class="seed-row">
                    <div class="seed-row-head">
                      <span class="seed-row-label">Row {index + 1}</span>
                      <button type="button" class="btn-row-remove" onclick={() => removeSeedRow(index)} aria-label="Remove row {index + 1}">
                        Remove
                      </button>
                    </div>
                    <input
                      type="text"
                      bind:value={row.path}
                      placeholder="/notes/brief.md"
                      class="input-field font-mono"
                      aria-label="Row {index + 1} file path"
                      oninput={clearMessages}
                    />
                    <textarea
                      bind:value={row.content}
                      rows="3"
                      placeholder="File content (paste supported)"
                      class="textarea-field font-mono"
                      aria-label="Row {index + 1} file content"
                      oninput={clearMessages}
                    ></textarea>
                  </div>
                {/each}
                <div class="rows-actions">
                  <button type="button" class="btn-secondary btn-xs" onclick={addSeedRow}>+ Add file row</button>
                </div>
              </div>

              <div class="form-group">
                <label for="realm-seed-directive">Directive <span class="opt">(optional)</span></label>
                <textarea
                  id="realm-seed-directive"
                  bind:value={seedDirective}
                  rows="3"
                  placeholder="Operator instruction delivered to the target member's mailbox"
                  class="textarea-field"
                  oninput={clearMessages}
                ></textarea>
              </div>
            </div>

            <div class="modal-footer compact">
              <button type="button" class="btn-secondary" onclick={() => onclose()} disabled={isSeeding}>Skip &amp; Close</button>
              <button type="submit" class="btn-primary" disabled={isSeeding}>
                {isSeeding ? 'Seeding…' : 'Seed Realm'}
              </button>
            </div>
          </form>
        {/if}
      {/if}
    {/if}

    {#if filesDialogOpen}
      <div class="files-dialog-backdrop">
        <div class="files-dialog" role="dialog" aria-modal="true" aria-label="Resolved file contents">
          <div class="files-dialog-header">
            <div class="section-title-wrap">
              <span class="section-badge">Files</span>
              <h4 class="section-title">Resolved file contents ({fileSlots.length})</h4>
            </div>
            <button type="button" class="btn-close" onclick={closeFilesDialog} aria-label="Close files dialog">
              <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <p class="field-hint">
            Every declared placement with its resolved content. Bundle-file destinations ship in the bundle;
            input destinations resolve from the launch inputs (then the attached payload) and are edited at the input
            field — this dialog is read-only.
          </p>
          {#if fileSlots.length === 0}
            <p class="rows-empty">This template declares no placements.</p>
          {/if}
          {#each fileSlots as slot (slot.key)}
            <div class="file-slot" class:file-slot-fixed={slot.source === 'bundle'} class:file-slot-conflict={slot.conflict}>
              <div class="file-slot-head">
                <span class="slot-path font-mono">{slot.path}</span>
                <span
                  class="slot-origin"
                  class:origin-generated={slot.origin === 'generated'}
                  class:origin-user={slot.origin === 'user'}
                >
                  {slot.origin}
                </span>
                {#if slot.required}
                  <span class="required-badge">required</span>
                {/if}
                {#if slot.conflict}
                  <span class="unknown-badge">conflict</span>
                {/if}
                <span class="file-slot-source">{slot.sourceLabel}</span>
              </div>
              <span class="field-hint">
                {slot.targetLabel}{#if slot.inputLabel} · input "{slot.inputLabel}"{/if}{#if slot.brief} · {slot.brief}{/if}
              </span>
              {#if slot.editable}
                <textarea
                  rows="4"
                  class="textarea-field font-mono"
                  value={slot.content}
                  aria-label={`Content for ${slot.path}`}
                  oninput={(event) => setFileEdit(slot, event.currentTarget.value)}
                ></textarea>
                <div class="input-actions">
                  <button type="button" class="btn-secondary btn-xs" disabled={!slot.edited} onclick={() => resetFileEdit(slot)}>
                    Reset to source
                  </button>
                  {#if slot.edited}
                    <span class="input-dirty-note">Edited — travels in the launch payload.</span>
                  {/if}
                </div>
              {:else}
                <pre class="file-slot-readonly">{slot.content}</pre>
                <span class="field-hint">
                  {slot.source === 'bundle'
                    ? 'Shipped in the bundle — the format forbids payload overrides for bundle-file destinations.'
                    : 'Resolved from the input — edit it at the input field above.'}
                </span>
              {/if}
            </div>
          {/each}
          <div class="modal-footer compact">
            <button type="button" class="btn-primary" onclick={closeFilesDialog}>Done</button>
          </div>
        </div>
      </div>
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

  .realm-launcher-modal {
    width: 100%;
    max-width: 780px;
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 1.75rem;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    position: relative;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .icon-chip {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--accent-primary-subtle);
    border: 1px solid var(--accent-primary-border);
    color: var(--accent-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .modal-sub {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0.15rem 0 0 0;
  }

  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.35rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .btn-close:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .step-rail {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .step-chip {
    font-size: 0.74rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    padding: 0.25rem 0.7rem;
  }

  .step-chip.active {
    color: var(--accent-primary);
    border-color: var(--accent-primary-border);
    background: var(--accent-primary-subtle);
  }

  .step-chip.done {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.35);
  }

  .step-connector {
    flex: 1;
    height: 1px;
    background: var(--border-subtle);
  }

  .error-banner,
  .notice-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.7rem 0.95rem;
    border-radius: 8px;
    font-size: 0.84rem;
  }

  .error-banner {
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
  }

  .notice-banner {
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #34d399;
  }

  .launcher-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-group.grow {
    min-width: 0;
  }

  .color-group {
    width: 86px;
  }

  .create-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.85rem;
    align-items: end;
  }

  label,
  .label-text {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .req {
    color: #f87171;
  }

  .opt {
    font-weight: normal;
    font-size: 0.74rem;
    color: var(--text-muted);
  }

  .input-field,
  .select-field,
  .textarea-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    font-size: 0.86rem;
    font-family: inherit;
  }

  .textarea-field {
    resize: vertical;
    min-height: 64px;
  }

  .input-field:focus,
  .select-field:focus,
  .textarea-field:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .color-input {
    width: 100%;
    height: 34px;
    padding: 2px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
  }

  .field-hint {
    font-size: 0.73rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .settings-section-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .section-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.5rem;
    gap: 0.75rem;
  }

  .section-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.12rem 0.45rem;
    border-radius: 4px;
    background: var(--accent-primary-subtle);
    color: var(--accent-primary);
    border: 1px solid var(--accent-primary-border);
  }

  .section-title {
    margin: 0;
    font-size: 0.92rem;
    color: var(--text-primary);
    font-weight: 600;
  }

  .agent-preview-card {
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    background: var(--bg-secondary);
  }

  .agent-preview-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .agent-preview-identity {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .agent-preview-name {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .agent-preview-id {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .agent-preview-badges {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 0.64rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    border: 1px solid transparent;
    letter-spacing: 0.02em;
    line-height: 1.3;
  }

  .badge-sudo {
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
  }

  .badge-muted {
    background: var(--bg-base);
    color: var(--text-muted);
    border-color: var(--border-subtle);
  }

  .badge-wildcard {
    background: var(--accent-danger-subtle);
    color: #f87171;
    border-color: var(--accent-danger-border);
  }

  .badge-success {
    background: rgba(52, 211, 153, 0.12);
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.35);
  }

  .agent-preview-role {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .agent-preview-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .meta-line {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    font-size: 0.76rem;
  }

  .meta-label {
    color: var(--text-muted);
    min-width: 90px;
  }

  .meta-value {
    color: var(--text-secondary);
    word-break: break-word;
  }

  .unrecognized-note {
    margin: 0;
    font-size: 0.76rem;
    color: #f59e0b;
  }

  .grant-groups {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .grant-details {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    background: var(--bg-base);
  }

  .grant-details summary {
    cursor: pointer;
    font-size: 0.74rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .chip-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding-top: 0.4rem;
  }

  .tool-chip {
    font-size: 0.64rem;
    padding: 0.08rem 0.3rem;
    border-radius: 3px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .tool-chip.mutating {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.35);
    background: rgba(245, 158, 11, 0.08);
  }

  .tool-chip.readonly {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.3);
    background: rgba(52, 211, 153, 0.07);
  }

  .grant-note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .input-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .input-dirty-note {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .input-warning {
    color: #f59e0b;
  }

  .input-error {
    font-size: 0.76rem;
    color: #f87171;
  }

  .seed-summary-line {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .seed-directive-preview {
    color: var(--text-muted);
    font-style: italic;
  }

  .seed-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .seed-toggle input {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-color, #7c9cff);
    cursor: pointer;
  }

  .prompt-preview {
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    background: var(--bg-base);
  }

  .prompt-preview summary {
    cursor: pointer;
    font-size: 0.74rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .prompt-preview-text {
    margin: 0.4rem 0 0;
    padding: 0.5rem 0.65rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    font-size: 0.74rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow-y: auto;
  }

  .prompt-preview-note {
    margin: 0.4rem 0 0;
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .prompt-preview-missing {
    color: #f59e0b;
  }

  .launch-receipt {
    background: rgba(52, 211, 153, 0.08);
    border: 1px solid rgba(52, 211, 153, 0.3);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .receipt-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .receipt-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .receipt-id {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .receipt-copy {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .written-paths {
    list-style: none;
    margin: 0;
    padding: 0.5rem 0.65rem;
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 140px;
    overflow-y: auto;
  }

  .written-paths li {
    font-size: 0.76rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .seed-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem;
    background: var(--bg-secondary);
  }

  .seed-row-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .seed-row-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .btn-row-remove {
    background: transparent;
    border: 1px solid transparent;
    color: #f87171;
    font-size: 0.72rem;
    cursor: pointer;
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }

  .btn-row-remove:hover {
    border-color: var(--accent-danger-border);
    background: var(--accent-danger-subtle);
  }

  .rows-empty {
    margin: 0;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .rows-actions {
    display: flex;
    justify-content: flex-start;
  }

  .btn-xs {
    font-size: 0.72rem;
    padding: 0.25rem 0.6rem;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border-subtle);
  }

  .modal-footer.compact {
    padding-top: 0;
    border-top: none;
  }

  .btn-primary,
  .btn-secondary,
  .btn-danger,
  .btn-danger-outline {
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary {
    background: var(--accent-primary);
    color: #fff;
  }

  .btn-primary:disabled,
  .btn-secondary:disabled,
  .btn-danger:disabled,
  .btn-danger-outline:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-surface);
    border-color: var(--border-color);
    color: var(--text-primary);
  }

  .btn-danger {
    background: #dc2626;
    color: #fff;
  }

  .btn-danger-outline {
    background: transparent;
    border-color: var(--accent-danger-border);
    color: #f87171;
  }

  .btn-danger-outline:hover {
    background: var(--accent-danger-subtle);
  }

  .template-picker-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .template-picker-row .select-field {
    flex: 1;
    min-width: 0;
  }

  .template-picker-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .template-source-line {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
    font-size: 0.73rem;
    color: var(--text-muted);
  }

  .source-badge {
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-base);
    color: var(--text-secondary);
  }

  .source-badge.source-imported {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.12);
  }

  .template-version {
    font-size: 0.68rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  .template-delete-confirm {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid var(--accent-danger-border);
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    background: var(--accent-danger-subtle);
  }

  .template-delete-copy {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-secondary);
    line-height: 1.45;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .origin-badge {
    margin-left: 0.4rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid rgba(124, 156, 255, 0.4);
    background: rgba(124, 156, 255, 0.14);
    color: #9db4ff;
    vertical-align: middle;
  }

  .hydration-brief {
    color: var(--text-secondary);
  }

  .history-entry {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    margin-top: 0.4rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
  }

  .history-role {
    align-self: flex-start;
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-base);
    color: var(--text-muted);
  }

  .history-role.role-agent {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.35);
    background: rgba(52, 211, 153, 0.08);
  }

  .history-content {
    margin: 0;
    font-size: 0.74rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 140px;
    overflow-y: auto;
  }

  .slot-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .slot-list-title {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .slot-path {
    font-size: 0.76rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .slot-origin {
    flex-shrink: 0;
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .slot-origin.origin-user {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.35);
  }

  .slot-origin.origin-generated {
    color: #9db4ff;
    border-color: rgba(124, 156, 255, 0.4);
  }

  /* Wave U review surfaces (ticket 458e727) */

  .payload-source-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .payload-source-row .select-field {
    flex: 1;
    min-width: 180px;
  }

  .payload-attached-badge {
    font-size: 0.64rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.12rem 0.45rem;
    border-radius: 999px;
    background: rgba(52, 211, 153, 0.12);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #34d399;
  }

  .payload-candidate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    background: var(--bg-base);
    flex-wrap: wrap;
  }

  .payload-candidate-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .payload-candidate-title {
    font-size: 0.72rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .btn-secondary.active-candidate {
    border-color: rgba(52, 211, 153, 0.45);
    color: #34d399;
  }

  .payload-status {
    margin: 0;
    font-size: 0.76rem;
    color: var(--text-secondary);
    word-break: break-word;
  }

  .payload-status.payload-empty {
    color: var(--text-muted);
  }

  .payload-error {
    margin: 0;
    font-size: 0.78rem;
    color: #f87171;
    word-break: break-word;
  }

  .payload-input-note {
    color: #9db4ff;
  }

  .disclosure-grid {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.6rem;
    border: 1px dashed var(--border-subtle);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.12);
  }

  .disclosure-line .meta-label {
    min-width: 110px;
  }

  .disclosure-value {
    word-break: break-word;
    white-space: pre-wrap;
  }

  .disclosure-empty {
    color: var(--text-muted);
  }

  .badge-authority {
    background: rgba(168, 85, 247, 0.16);
    color: #c084fc;
    border-color: rgba(168, 85, 247, 0.4);
  }

  .part-list {
    list-style: none;
    margin: 0.4rem 0 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .part-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .part-origin {
    flex-shrink: 0;
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.06rem 0.3rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .part-origin.origin-user {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.35);
  }

  .part-origin.origin-generated {
    color: #9db4ff;
    border-color: rgba(124, 156, 255, 0.4);
  }

  .part-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all;
  }

  .part-note {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .part-note-empty {
    color: #f59e0b;
  }

  .part-input-edit {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    font-size: 0.74rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    resize: vertical;
  }

  .authority-agent {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    background: var(--bg-base);
  }

  .authority-agent-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .authority-agent-name {
    font-size: 0.86rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .authority-agent-key {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .authority-row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid rgba(168, 85, 247, 0.22);
    border-radius: 6px;
    background: rgba(168, 85, 247, 0.05);
    cursor: pointer;
  }

  .authority-row.authority-row-trusted {
    border-color: rgba(52, 211, 153, 0.35);
    background: rgba(52, 211, 153, 0.06);
    cursor: default;
  }

  .authority-row input {
    margin-top: 3px;
    accent-color: #a855f7;
    cursor: pointer;
  }

  .authority-row.authority-row-trusted input {
    accent-color: #34d399;
  }

  .authority-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .authority-title-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .authority-title {
    font-size: 0.78rem;
    color: var(--text-primary);
  }

  .authority-label {
    font-size: 0.74rem;
    font-weight: 600;
    color: #c084fc;
  }

  .trust-badge {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    background: rgba(52, 211, 153, 0.12);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #34d399;
  }

  .unknown-badge {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
  }

  .trust-control {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border-subtle);
  }

  .review-gate {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .review-ack {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid rgba(124, 156, 255, 0.35);
    border-radius: 8px;
    background: rgba(124, 156, 255, 0.07);
    font-size: 0.8rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .review-ack input {
    margin-top: 2px;
    accent-color: #7c9cff;
    cursor: pointer;
  }

  .launch-gate-hint {
    margin: 0;
    font-size: 0.76rem;
    color: #f59e0b;
  }

  .files-dialog-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(12, 13, 14, 0.72);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    border-radius: 12px;
    z-index: 5;
  }

  .files-dialog {
    width: 100%;
    max-width: 640px;
    max-height: 85%;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    box-shadow: var(--shadow-lg);
  }

  .files-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.5rem;
    gap: 0.6rem;
  }

  .file-slot {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.55rem 0.65rem;
    background: var(--bg-surface);
  }

  .file-slot.file-slot-fixed {
    background: var(--bg-base);
  }

  .file-slot-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .file-slot-source {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .required-badge {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.06rem 0.3rem;
    border-radius: 4px;
    border: 1px solid rgba(245, 158, 11, 0.35);
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
  }

  .file-slot-readonly {
    margin: 0;
    padding: 0.45rem 0.55rem;
    border: 1px dashed var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-base);
    font-size: 0.72rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 160px;
    overflow-y: auto;
  }

  /* Format-v2 input requirements and usage map (ticket a71198f) */

  .shape-badge {
    margin-left: 0.4rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-base);
    color: var(--text-muted);
    vertical-align: middle;
  }

  .fileset-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.55rem 0.65rem;
    background: var(--bg-secondary);
  }

  .attachment-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
    background: var(--bg-base);
  }

  .attachment-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .attachment-head .input-field {
    flex: 1;
    min-width: 0;
  }

  .attachment-content summary {
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .usage-map {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border: 1px dashed var(--border-subtle);
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
    background: rgba(0, 0, 0, 0.12);
  }

  .usage-summary {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .usage-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .usage-row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .usage-kind {
    flex-shrink: 0;
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.06rem 0.3rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .usage-label {
    font-weight: 600;
  }

  .usage-path {
    font-size: 0.7rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .usage-detail {
    color: var(--text-muted);
  }

  /* Hydration workspace additions (ticket 874182b): placement mapping,
     per-file destinations, saved payloads, pin/digest card, directives. */

  .placement-map {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .placement-row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .placement-mode {
    flex-shrink: 0;
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 0.06rem 0.3rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface);
    color: var(--text-muted);
  }

  .placement-target {
    font-weight: 600;
  }

  .placement-destination {
    font-size: 0.7rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .attachment-destinations {
    color: var(--text-secondary);
  }

  .save-payload-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.45rem;
  }

  .save-payload-row .input-field {
    flex: 1;
    min-width: 0;
  }

  .pin-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.55rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
    background: var(--bg-base);
  }

  .pin-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.72rem;
  }

  .pin-label {
    flex-shrink: 0;
    min-width: 6.5rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .pin-value {
    color: var(--text-secondary);
    word-break: break-all;
  }

  .pin-value-missing {
    color: var(--accent-danger);
  }

  .directive-review {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.35rem;
  }

  .directive-row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .directive-target {
    font-weight: 600;
  }

  .file-slot-conflict {
    border-color: var(--accent-danger-border);
    background: var(--accent-danger-subtle);
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 640px) {
    .create-grid,
    .grant-groups {
      grid-template-columns: 1fr;
    }
    .color-group {
      width: 100%;
    }
  }
</style>
