<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import {
    downloadSingleFile,
    downloadFilesSeparately,
    downloadFolderAsArchive,
    detectArchiveCapability,
    isFolderUploadSupported,
    extractFilesFromDataTransfer,
    processUploadedFiles
  } from '../../sandbox/fsDownloadUtils/index.ts';

  const reportTitleId = $props.id();

  let selectedFilePath = $state(null);
  let isFormattedJson = $state(true);

  // Quick file creation state
  let showCreateModal = $state(false);
  let newFilePath = $state('/data.json');
  let newFileContent = $state('{\n  "status": "ready"\n}');
  let newFileReadOnly = $state(false);

  // Copy file modal state
  let showCopyModal = $state(false);
  let copySrcFile = $state(null);
  let copyDestPath = $state('');
  let copyDestWorkspace = $state('global');
  let copyOverwrite = $state(true);

  // Multi-select state
  let selectedFilePaths = $state(new Set());

  // AST JSON Query widget state
  let jsonKeyPath = $state('');
  let jsonQueryResult = $state(/** @type {unknown} */(null));
  let jsonQueryError = $state(null);

  // Grep widget state
  let grepPattern = $state('');
  let grepIsRegex = $state(false);
  let grepResults = $state(null);
  let grepError = $state(null);

  // Transfer & Menu state
  let showDownloadMenu = $state(false);
  let showUploadMenu = $state(false);
  let isTransferring = $state(false);
  let isDraggingOver = $state(false);
  let transferStatus = $state(null);

  /**
   * Transfer notification banner state. `failures` is populated when a separate
   * download batch completes with per-entry failures.
   * @typedef {Object} TransferNotice
   * @property {string} message
   * @property {Array<{ path?: string|null, error?: string, index?: number }>} [failures]
   * @property {boolean} [canDownloadSeparately]
   * @property {boolean} [isSelection]
   * @property {boolean} [isAll]
   * @property {string} [workspaceId]
   */

  /** @type {TransferNotice|null} */
  let transferError = $state(null);
  let transferProgress = $state({ current: 0, total: 0, file: '' });
  let statusTimer = null;

  // File input refs
  let fileInputRef = $state(null);
  let folderInputRef = $state(null);

  // Derived active workspace files
  let currentWorkspace = $derived(sandboxStore.activeFsWorkspace);
  let files = $derived(sandboxStore.activeFsFiles);
  let isAllSelected = $derived(files.length > 0 && selectedFilePaths.size === files.length);

  // Selected file content
  let selectedFile = $derived.by(() => {
    if (!selectedFilePath) return null;
    const ws = sandboxStore.fsSnapshot[currentWorkspace];
    if (!ws) return null;
    return ws[selectedFilePath] || null;
  });

  function selectWorkspace(wsId) {
    sandboxStore.setActiveFsWorkspace(wsId);
    selectedFilePath = null;
    selectedFilePaths = new Set();
    jsonQueryResult = null;
    jsonQueryError = null;
    showDownloadMenu = false;
    showUploadMenu = false;
  }

  function handleSelectFile(path) {
    selectedFilePath = path;
    jsonQueryResult = null;
    jsonQueryError = null;
  }

  function showStatus(msg, duration = 3500) {
    transferStatus = msg;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      transferStatus = null;
    }, duration);
  }

  /**
   * Defensive read of a separate-download receipt's per-entry failure list.
   * The runtime receipt shape is `{ success, count, files, failures }`; any other
   * shape (or a missing list) yields an empty array so success handling is unaffected.
   * @param {any} receipt
   * @returns {Array<{ path?: string|null, error?: string, index?: number }>}
   */
  function getDownloadFailures(receipt) {
    return receipt && Array.isArray(receipt.failures) ? receipt.failures : [];
  }

  /**
   * Human-readable label for one failed download entry, preferring its path.
   * @param {{ path?: string|null, error?: string, index?: number }} failure
   * @returns {string}
   */
  function formatFailedEntry(failure) {
    if (failure && typeof failure.path === 'string' && failure.path.trim()) return failure.path;
    if (failure && typeof failure.index === 'number') return `entry #${failure.index + 1}`;
    return 'unknown path';
  }

  /**
   * Surfaces a partial-failure banner naming the failed paths instead of a
   * success toast. Returns true when a notice was shown.
   * @param {any} receipt
   * @param {string} scopeLabel - e.g. 'file(s) from [global]'
   * @returns {boolean}
   */
  function reportPartialDownloadFailure(receipt, scopeLabel) {
    const failures = getDownloadFailures(receipt);
    if (failures.length === 0) return false;
    const succeeded = typeof receipt?.count === 'number' ? receipt.count : 0;
    if (statusTimer) clearTimeout(statusTimer);
    transferStatus = null;
    transferError = {
      message: `Downloaded ${succeeded} of ${succeeded + failures.length} ${scopeLabel}; ${failures.length} failed.`,
      failures
    };
    return true;
  }

  // --- Multi-Selection Handlers ---
  function toggleSelectFile(path, e) {
    if (e) e.stopPropagation();
    const next = new Set(selectedFilePaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    selectedFilePaths = next;
  }

  function toggleSelectAll() {
    if (isAllSelected) {
      selectedFilePaths = new Set();
    } else {
      selectedFilePaths = new Set(files.map(f => f.path));
    }
  }

  function clearSelection() {
    selectedFilePaths = new Set();
  }

  // --- Single & Bulk Download Handlers ---
  function handleDownloadSingleFile(f, e) {
    if (e) e.stopPropagation();
    try {
      const ws = sandboxStore.fsSnapshot[currentWorkspace] || {};
      const fileData = ws[f.path] || f;
      const receipt = downloadSingleFile({
        path: f.path,
        content: fileData.content !== undefined ? fileData.content : (selectedFile?.path === f.path ? selectedFile.content : ''),
        workspaceId: currentWorkspace,
        readOnly: f.readOnly
      });
      showStatus(`Downloaded ${receipt.filename}`);
    } catch (err) {
      transferError = { message: `File download failed: ${err.message}` };
    }
  }

  async function handleDownloadWorkspaceArchive(wsId = currentWorkspace) {
    isTransferring = true;
    transferError = null;
    showDownloadMenu = false;

    try {
      const res = await sandboxStore.downloadWorkspaceArchive(wsId);
      if (!res.success) {
        if (res.capability === 'none') {
          transferError = {
            message: 'No native archiving utility (ZIP or CompressionStream) is available in this browser environment.',
            canDownloadSeparately: true,
            workspaceId: wsId
          };
        } else {
          transferError = { message: res.error || 'Archive download failed' };
        }
      } else {
        showStatus(`Downloaded archive ${res.filename} (${res.format})`);
      }
    } catch (err) {
      if (err.capability === 'none') {
        transferError = {
          message: 'No native archiving utility (ZIP or CompressionStream) is available in this browser environment.',
          canDownloadSeparately: true,
          workspaceId: wsId
        };
      } else {
        transferError = { message: `Archive download failed: ${err.message}` };
      }
    } finally {
      isTransferring = false;
    }
  }

  async function handleDownloadWorkspaceSeparately(wsId = currentWorkspace) {
    isTransferring = true;
    transferError = null;
    showDownloadMenu = false;

    try {
      const res = await sandboxStore.downloadWorkspaceFilesSeparately(wsId, (cur, tot, file) => {
        transferProgress = { current: cur, total: tot, file };
        showStatus(`Downloading file ${cur}/${tot}: ${file}...`, 5000);
      });
      if (!reportPartialDownloadFailure(res, `file(s) from [${wsId}]`)) {
        showStatus(`Downloaded ${res.count} files separately`);
      }
    } catch (err) {
      transferError = { message: `Separate file downloads failed: ${err.message}` };
    } finally {
      isTransferring = false;
      transferProgress = { current: 0, total: 0, file: '' };
    }
  }

  async function handleDownloadSelectedArchive() {
    if (selectedFilePaths.size === 0) return;
    isTransferring = true;
    transferError = null;

    const ws = sandboxStore.fsSnapshot[currentWorkspace] || {};
    const selectedFiles = Array.from(selectedFilePaths).map(p => {
      const item = ws[p] || {};
      return {
        path: p,
        content: item.content !== undefined ? item.content : '',
        workspaceId: currentWorkspace,
        size: item.size,
        updatedAt: item.updatedAt,
        readOnly: item.readOnly
      };
    });

    try {
      const res = await downloadFolderAsArchive(selectedFiles, {
        archiveName: `${currentWorkspace}_selected_files`,
        workspaceId: currentWorkspace
      });
      if (!res.success) {
        if (res.capability === 'none') {
          transferError = {
            message: 'No native archiving utility (ZIP or CompressionStream) is available in this browser.',
            canDownloadSeparately: true,
            isSelection: true
          };
        } else {
          transferError = { message: res.error || 'Archive download failed' };
        }
      } else {
        showStatus(`Downloaded archive ${res.filename} (${res.filesCount} files)`);
      }
    } catch (err) {
      transferError = { message: `Selected files archive failed: ${err.message}` };
    } finally {
      isTransferring = false;
    }
  }

  async function handleDownloadSelectedSeparately() {
    if (selectedFilePaths.size === 0) return;
    isTransferring = true;
    transferError = null;

    const ws = sandboxStore.fsSnapshot[currentWorkspace] || {};
    const selectedFiles = Array.from(selectedFilePaths).map(p => {
      const item = ws[p] || {};
      return {
        path: p,
        content: item.content !== undefined ? item.content : '',
        workspaceId: currentWorkspace
      };
    });

    try {
      const res = await downloadFilesSeparately(selectedFiles, {
        prefixWorkspace: false,
        onProgress: (cur, tot, file) => {
          transferProgress = { current: cur, total: tot, file };
          showStatus(`Downloading file ${cur}/${tot}: ${file}...`, 5000);
        }
      });
      if (!reportPartialDownloadFailure(res, 'selected file(s)')) {
        showStatus(`Downloaded ${res.count} selected files separately`);
      }
    } catch (err) {
      transferError = { message: `Separate downloads failed: ${err.message}` };
    } finally {
      isTransferring = false;
      transferProgress = { current: 0, total: 0, file: '' };
    }
  }

  async function handleDownloadAllWorkspacesArchive() {
    isTransferring = true;
    transferError = null;
    showDownloadMenu = false;

    try {
      const res = await sandboxStore.downloadAllWorkspacesArchive();
      if (!res.success) {
        if (res.capability === 'none') {
          transferError = {
            message: 'No native archiving utility (ZIP or CompressionStream) is available in this browser environment.',
            canDownloadSeparately: true,
            isAll: true
          };
        } else {
          transferError = { message: res.error || 'All workspaces archive failed' };
        }
      } else {
        showStatus(`Downloaded all workspaces as ${res.filename} (${res.format})`);
      }
    } catch (err) {
      transferError = { message: `All workspaces archive failed: ${err.message}` };
    } finally {
      isTransferring = false;
    }
  }

  async function handleDownloadAllWorkspacesSeparately() {
    isTransferring = true;
    transferError = null;
    showDownloadMenu = false;

    try {
      const res = await sandboxStore.downloadAllWorkspacesFilesSeparately((cur, tot, file) => {
        transferProgress = { current: cur, total: tot, file };
        showStatus(`Downloading file ${cur}/${tot}: ${file}...`, 5000);
      });
      if (!reportPartialDownloadFailure(res, 'file(s) across all workspaces')) {
        showStatus(`Downloaded ${res.count} files separately across all workspaces`);
      }
    } catch (err) {
      transferError = { message: `Separate downloads failed: ${err.message}` };
    } finally {
      isTransferring = false;
      transferProgress = { current: 0, total: 0, file: '' };
    }
  }

  // --- Upload Handlers ---
  function handleTriggerUploadFiles() {
    showUploadMenu = false;
    if (fileInputRef) {
      fileInputRef.click();
    }
  }

  function handleTriggerUploadFolder() {
    showUploadMenu = false;
    if (isFolderUploadSupported()) {
      if (folderInputRef) folderInputRef.click();
    } else {
      showStatus('Folder selection not supported by browser; opening file selector', 4000);
      if (fileInputRef) fileInputRef.click();
    }
  }

  async function handleFileInputChange(e) {
    const inputFiles = e.target.files;
    if (!inputFiles || inputFiles.length === 0) return;

    isTransferring = true;
    transferError = null;
    try {
      const res = await sandboxStore.uploadFiles(inputFiles, currentWorkspace, {
        onProgress: (cur, tot, file) => {
          transferProgress = { current: cur, total: tot, file };
          showStatus(`Uploading ${cur}/${tot}: ${file}...`, 5000);
        }
      });
      refreshGrepResults();
      showStatus(`Successfully uploaded ${res.count} file(s) to [${currentWorkspace}]`);
    } catch (err) {
      transferError = { message: `Upload failed: ${err.message}` };
    } finally {
      isTransferring = false;
      transferProgress = { current: 0, total: 0, file: '' };
      e.target.value = '';
    }
  }

  async function handleDrop(e) {
    e.preventDefault();
    isDraggingOver = false;

    if (!e.dataTransfer) return;

    isTransferring = true;
    transferError = null;
    try {
      const extracted = await extractFilesFromDataTransfer(e.dataTransfer);
      if (extracted.length === 0) {
        showStatus('No readable files dropped', 3000);
        return;
      }
      const res = await sandboxStore.uploadFiles(extracted, currentWorkspace, {
        onProgress: (cur, tot, file) => {
          transferProgress = { current: cur, total: tot, file };
          showStatus(`Uploading ${cur}/${tot}: ${file}...`, 5000);
        }
      });
      refreshGrepResults();
      showStatus(`Successfully uploaded ${res.count} dropped item(s) to [${currentWorkspace}]`);
    } catch (err) {
      transferError = { message: `Drop upload failed: ${err.message}` };
    } finally {
      isTransferring = false;
      transferProgress = { current: 0, total: 0, file: '' };
    }
  }

  // --- Copy File Handlers ---
  function openCopyModal(f, e) {
    if (e) e.stopPropagation();
    copySrcFile = f;
    copyDestWorkspace = currentWorkspace;
    const base = f.path.replace(/^\/+/, '');
    if (base.includes('.')) {
      copyDestPath = '/' + base.replace(/(\.[^.]+)$/, '_copy$1');
    } else {
      copyDestPath = '/' + base + '_copy';
    }
    copyOverwrite = true;
    showCopyModal = true;
  }

  function handleExecuteCopy(e) {
    e.preventDefault();
    if (!copySrcFile || !copyDestPath.trim()) return;

    try {
      sandboxStore.copyFile(copySrcFile.path, copyDestPath.trim(), {
        srcWorkspaceId: currentWorkspace,
        destWorkspaceId: copyDestWorkspace,
        overwrite: copyOverwrite
      });
      refreshGrepResults();
      showStatus(`Copied ${copySrcFile.path} to [${copyDestWorkspace}] ${copyDestPath.trim()}`);
      showCopyModal = false;
    } catch (err) {
      alert(`Copy failed: ${err.message}`);
    }
  }

  // --- Delete Handlers ---
  function handleDeleteFile(path, e) {
    if (e) e.stopPropagation();
    if (!confirm(`Are you sure you want to delete '${path}' from workspace [${currentWorkspace}]?`)) return;
    try {
      sandboxStore.deleteFile(path, currentWorkspace);
      if (selectedFilePath === path) {
        selectedFilePath = null;
      }
      const next = new Set(selectedFilePaths);
      next.delete(path);
      selectedFilePaths = next;
      refreshGrepResults();
      showStatus(`Deleted ${path}`);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  function handleDeleteSelected() {
    if (selectedFilePaths.size === 0) return;
    const count = selectedFilePaths.size;
    if (!confirm(`Are you sure you want to delete ${count} selected file(s) from [${currentWorkspace}]?`)) return;

    try {
      const res = sandboxStore.deleteFiles(Array.from(selectedFilePaths), currentWorkspace);
      selectedFilePaths = new Set();
      if (selectedFilePath && res.deleted.includes(selectedFilePath)) {
        selectedFilePath = null;
      }
      refreshGrepResults();
      showStatus(`Deleted ${res.count} file(s) from [${currentWorkspace}]`);
    } catch (err) {
      alert(`Bulk delete failed: ${err.message}`);
    }
  }

  function handleClearWorkspace() {
    if (files.length === 0) return;
    if (!confirm(`Are you sure you want to delete ALL ${files.length} file(s) in workspace [${currentWorkspace}]?`)) return;

    try {
      const allPaths = files.map(f => f.path);
      const res = sandboxStore.deleteFiles(allPaths, currentWorkspace);
      selectedFilePaths = new Set();
      selectedFilePath = null;
      refreshGrepResults();
      showStatus(`Cleared ${res.count} file(s) from [${currentWorkspace}]`);
    } catch (err) {
      alert(`Clear workspace failed: ${err.message}`);
    }
  }

  // --- File Creation & Tool Handlers ---
  function handleCreateFile(e) {
    e.preventDefault();
    if (!newFilePath.trim()) return;

    try {
      sandboxStore.writeFile(newFilePath.trim(), newFileContent, {
        workspaceId: currentWorkspace,
        readOnly: newFileReadOnly
      });
      selectedFilePath = newFilePath.trim().startsWith('/') ? newFilePath.trim() : '/' + newFilePath.trim();
      showCreateModal = false;
      refreshGrepResults();
      showStatus(`Created ${selectedFilePath}`);
    } catch (err) {
      alert(`File creation failed: ${err.message}`);
    }
  }

  function handleExecuteJsonQuery(e) {
    if (e) e.preventDefault();
    if (!selectedFilePath) {
      jsonQueryError = 'Please select a JSON file first';
      jsonQueryResult = null;
      return;
    }

    try {
      jsonQueryError = null;
      const res = sandboxStore.queryJson(selectedFilePath, jsonKeyPath.trim(), currentWorkspace);
      jsonQueryResult = res;
    } catch (err) {
      jsonQueryError = err.message || 'JSON query failed';
      jsonQueryResult = null;
    }
  }

  function runGrep() {
    if (!grepPattern.trim()) {
      grepResults = [];
      return;
    }

    try {
      grepError = null;
      let pattern = grepPattern;
      if (grepIsRegex) {
        pattern = new RegExp(grepPattern);
      }
      const matches = sandboxStore.grep(pattern, currentWorkspace);
      grepResults = matches;
    } catch (err) {
      grepError = err.message || 'Grep search failed';
      grepResults = null;
    }
  }

  // Re-run the last grep after any VFS mutation so the panel never shows
  // matches for removed/changed files; no-op when no search has run.
  function refreshGrepResults() {
    if (grepResults === null) return;
    runGrep();
  }

  function handleExecuteGrep(e) {
    if (e) e.preventDefault();
    runGrep();
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || isNaN(bytes)) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDisplayContent(content) {
    if (!isFormattedJson) return content;
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch (_) {
      return content;
    }
  }
</script>

<!-- Hidden File / Folder Upload Inputs -->
<input
  type="file"
  multiple
  bind:this={fileInputRef}
  onchange={handleFileInputChange}
  style="display: none;"
/>
<input
  type="file"
  webkitdirectory
  directory
  multiple
  bind:this={folderInputRef}
  onchange={handleFileInputChange}
  style="display: none;"
/>

<div
  class="fs-explorer-container"
  class:dragging={isDraggingOver}
  role="region"
  aria-label="Virtual Filesystem Explorer"
  ondragover={(e) => { e.preventDefault(); isDraggingOver = true; }}
  ondragleave={(e) => { if (e.currentTarget === e.target) isDraggingOver = false; }}
  ondrop={handleDrop}
>
  <!-- Drag Overlay -->
  {#if isDraggingOver}
    <div class="drag-drop-overlay">
      <div class="drag-drop-card glass-panel">
        <svg class="icon-svg drag-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <h3>Drop Folders or Files</h3>
        <p>Drop items here to upload directly to workspace <code>[{currentWorkspace}]</code></p>
      </div>
    </div>
  {/if}

  <!-- Archiving / Transfer Notification Banner -->
  <div
    class="download-report-live-region"
    class:live-region-empty={!transferError}
    role="alert"
    aria-live="assertive"
    aria-atomic="true"
  >
    {#if transferError}
      <div class="download-report-banner glass-panel" role="group" aria-labelledby={reportTitleId}>
        <div class="report-header">
          <div class="report-title-group">
            <svg class="icon-svg warning-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span class="report-title font-mono" id={reportTitleId}>Notification</span>
          </div>
          <button type="button" class="btn-close-report" onclick={() => transferError = null} aria-label="Dismiss notification">✕</button>
        </div>
        <p class="report-text">{transferError.message}</p>
        {#if transferError.failures && transferError.failures.length > 0}
          <ul class="report-failure-list font-mono" aria-label="Files that failed to download">
            {#each transferError.failures as failure, i (i)}
              <li>
                <span class="failure-path">{formatFailedEntry(failure)}</span>
                {#if failure.error}
                  <span class="failure-reason">{failure.error}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if transferError.canDownloadSeparately}
          <div class="report-actions">
            <button
              type="button"
              class="btn-primary btn-sm"
              onclick={() => {
                const notice = transferError;
                const isAll = notice?.isAll;
                const isSel = notice?.isSelection;
                const targetWorkspace = notice?.workspaceId || currentWorkspace;
                transferError = null;
                if (isSel) {
                  handleDownloadSelectedSeparately();
                } else if (isAll) {
                  handleDownloadAllWorkspacesSeparately();
                } else {
                  handleDownloadWorkspaceSeparately(targetWorkspace);
                }
              }}
            >
              <span>Download Files Separately</span>
            </button>
            <button type="button" class="btn-secondary btn-sm" onclick={() => transferError = null}>
              Dismiss
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Status / Progress Toast -->
  {#if transferStatus}
    <div class="download-status-toast font-mono">
      <span class="status-indicator" class:pulse={isTransferring}></span>
      <span>{transferStatus}</span>
    </div>
  {/if}

  <!-- Workspace Selector Toolbar -->
  <div class="workspace-bar glass-panel">
    <div class="workspace-pills">
      {#each sandboxStore.allWorkspaces as wsId (wsId)}
        <button
          type="button"
          class="ws-pill"
          class:active={currentWorkspace === wsId}
          onclick={() => selectWorkspace(wsId)}
        >
          {#if wsId === 'global'}
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span>Global Shared</span>
          {:else}
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
            <span>{wsId}</span>
          {/if}
          <span class="file-count font-mono">
            {Object.keys(sandboxStore.fsSnapshot[wsId] || {}).length}
          </span>
        </button>
      {/each}
    </div>

    <!-- Workspace Actions: Upload, Download & Create File -->
    <div class="workspace-actions">
      <!-- Upload Dropdown -->
      <div class="dropdown-wrapper">
        <button
          type="button"
          class="btn-secondary btn-sm btn-action-trigger"
          class:active={showUploadMenu}
          onclick={() => { showUploadMenu = !showUploadMenu; showDownloadMenu = false; }}
          title="Upload folder or files into workspace"
          disabled={isTransferring}
        >
          <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>Upload</span>
          <svg class="icon-svg caret-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {#if showUploadMenu}
          <div class="action-dropdown-menu glass-panel" role="menu">
            <div class="menu-label font-mono">Upload to [{currentWorkspace}]</div>
            <button
              type="button"
              class="dropdown-item"
              onclick={handleTriggerUploadFolder}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>Upload Entire Folder</span>
            </button>
            <button
              type="button"
              class="dropdown-item"
              onclick={handleTriggerUploadFiles}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>Upload Individual Files</span>
            </button>
          </div>
        {/if}
      </div>

      <!-- Download Dropdown -->
      <div class="dropdown-wrapper">
        <button
          type="button"
          class="btn-secondary btn-sm btn-action-trigger"
          class:active={showDownloadMenu}
          onclick={() => { showDownloadMenu = !showDownloadMenu; showUploadMenu = false; }}
          title="Download workspace files or archives"
          disabled={isTransferring}
        >
          <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>Download</span>
          <svg class="icon-svg caret-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {#if showDownloadMenu}
          <div class="action-dropdown-menu glass-panel" role="menu">
            <div class="menu-label font-mono">Current Workspace [{currentWorkspace}]</div>
            <button
              type="button"
              class="dropdown-item"
              onclick={() => handleDownloadWorkspaceArchive(currentWorkspace)}
              disabled={files.length === 0 || isTransferring}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              <span>Download Folder as Archive (.zip / .tar.gz)</span>
            </button>
            <button
              type="button"
              class="dropdown-item"
              onclick={() => handleDownloadWorkspaceSeparately(currentWorkspace)}
              disabled={files.length === 0 || isTransferring}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span>Download Files Separately</span>
            </button>

            <div class="dropdown-divider"></div>
            <div class="menu-label font-mono">Global Local Filesystem</div>
            <button
              type="button"
              class="dropdown-item"
              onclick={handleDownloadAllWorkspacesArchive}
              disabled={isTransferring}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span>Download All Workspaces Archive</span>
            </button>
            <button
              type="button"
              class="dropdown-item"
              onclick={handleDownloadAllWorkspacesSeparately}
              disabled={isTransferring}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <span>Download All Files Separately</span>
            </button>

            <div class="dropdown-divider"></div>
            <button
              type="button"
              class="dropdown-item text-danger"
              onclick={handleClearWorkspace}
              disabled={files.length === 0}
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              <span>Clear Workspace Files</span>
            </button>
          </div>
        {/if}
      </div>

      <button type="button" class="btn-secondary btn-sm" onclick={() => showCreateModal = true}>
        <span>+ New File</span>
      </button>
    </div>
  </div>

  <!-- Bulk Action Bar (when files are selected) -->
  {#if selectedFilePaths.size > 0}
    <div class="bulk-action-bar glass-panel">
      <div class="bulk-info">
        <span class="bulk-count font-mono">{selectedFilePaths.size}</span>
        <span>file(s) selected</span>
      </div>
      <div class="bulk-buttons">
        <button
          type="button"
          class="btn-secondary btn-xs font-mono"
          onclick={handleDownloadSelectedArchive}
          title="Download selected files as archive"
        >
          <span>📦 Download Archive</span>
        </button>
        <button
          type="button"
          class="btn-secondary btn-xs font-mono"
          onclick={handleDownloadSelectedSeparately}
          title="Download selected files separately"
        >
          <span>📄 Download Separately</span>
        </button>
        <button
          type="button"
          class="btn-danger btn-xs font-mono"
          onclick={handleDeleteSelected}
          title="Delete selected files"
        >
          <span>🗑️ Delete ({selectedFilePaths.size})</span>
        </button>
        <button
          type="button"
          class="btn-text btn-xs font-mono"
          onclick={clearSelection}
        >
          <span>Clear Selection</span>
        </button>
      </div>
    </div>
  {/if}

  <!-- Main Workstation Panes -->
  <div class="fs-main-panes">
    <!-- Left Pane: File List -->
    <div class="file-list-pane glass-panel">
      <div class="pane-header">
        <div class="pane-title-group">
          <input
            type="checkbox"
            checked={isAllSelected}
            onchange={toggleSelectAll}
            title="Select / deselect all files"
            disabled={files.length === 0}
          />
          <h3 class="pane-title">Workspace Files ({files.length})</h3>
        </div>
        <div class="header-actions">
          <button
            type="button"
            class="btn-text-action font-mono"
            onclick={handleTriggerUploadFolder}
            title="Upload folder"
          >
            <span>📁 Upload Folder</span>
          </button>
          <button
            type="button"
            class="btn-text-action font-mono"
            onclick={() => handleDownloadWorkspaceArchive(currentWorkspace)}
            disabled={files.length === 0 || isTransferring}
            title="Download workspace archive"
          >
            <span>📦 Archive</span>
          </button>
        </div>
      </div>

      {#if files.length === 0}
        <div class="empty-files">
          <p>No files in workspace <code>{currentWorkspace}</code>.</p>
          <div class="empty-actions">
            <button type="button" class="btn-secondary btn-sm" onclick={() => showCreateModal = true}>
              Create Initial File
            </button>
            <button type="button" class="btn-secondary btn-sm" onclick={handleTriggerUploadFiles}>
              Upload Files
            </button>
          </div>
          <span class="drop-hint font-mono">Tip: Drag & drop folders or files directly into this panel</span>
        </div>
      {:else}
        <div class="files-table-wrapper">
          <table class="files-table">
            <thead>
              <tr>
                <th style="width: 28px;"></th>
                <th>Path</th>
                <th>Size</th>
                <th>Owner</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {#each files as f (f.path)}
                <tr
                  class="file-row"
                  class:selected={selectedFilePath === f.path}
                  class:checked={selectedFilePaths.has(f.path)}
                  onclick={() => handleSelectFile(f.path)}
                >
                  <td class="checkbox-cell" onclick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedFilePaths.has(f.path)}
                      onchange={(e) => toggleSelectFile(f.path, e)}
                    />
                  </td>
                  <td class="file-path font-mono">
                    <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>{f.path}</span>
                    {#if f.readOnly}
                      <span class="badge-readonly">RO</span>
                    {/if}
                  </td>
                  <td class="font-mono text-muted">{formatBytes(f.size)}</td>
                  <td>
                    <span class="badge-owner font-mono">{f.owner || 'system'}</span>
                  </td>
                  <td class="action-cell">
                    <button
                      type="button"
                      class="btn-icon-action"
                      onclick={(e) => handleDownloadSingleFile(f, e)}
                      title="Download file separately"
                    >
                      <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="btn-icon-action"
                      onclick={(e) => openCopyModal(f, e)}
                      title="Copy / duplicate file"
                    >
                      <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="btn-icon-action btn-delete-action"
                      onclick={(e) => handleDeleteFile(f.path, e)}
                      title="Delete file"
                    >
                      <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    <!-- Right Panes: Content Viewer & Live Query / Grep -->
    <div class="right-panes">
      <!-- File Content Viewer -->
      <div class="content-viewer-card glass-panel">
        <div class="viewer-header">
          {#if selectedFile}
            <div class="file-meta-header">
              <span class="font-mono file-active-path">{selectedFile.path}</span>
              <span class="meta-tag font-mono">{formatBytes(selectedFile.size)}</span>
              {#if selectedFile.readOnly}
                <span class="badge-readonly">Read-Only</span>
              {/if}
            </div>
            <div class="viewer-actions">
              <button
                type="button"
                class="btn-secondary btn-xs font-mono btn-viewer-action"
                onclick={() => handleDownloadSingleFile(selectedFile)}
                title="Download this file"
              >
                <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Download</span>
              </button>
              <button
                type="button"
                class="btn-secondary btn-xs font-mono btn-viewer-action"
                onclick={(e) => openCopyModal(selectedFile, e)}
                title="Copy / Duplicate this file"
              >
                <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy</span>
              </button>
              <button
                type="button"
                class="btn-danger-ghost btn-xs font-mono btn-viewer-action"
                onclick={(e) => handleDeleteFile(selectedFile.path, e)}
                title="Delete this file"
              >
                <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                <span>Delete</span>
              </button>
              <label class="toggle-label font-mono">
                <input type="checkbox" bind:checked={isFormattedJson} />
                <span>Format JSON</span>
              </label>
            </div>
          {:else}
            <span class="text-muted">Select a file to inspect contents</span>
          {/if}
        </div>

        <div class="viewer-body">
          {#if selectedFile}
            <pre class="file-code font-mono">{formatDisplayContent(selectedFile.content)}</pre>
          {:else}
            <div class="empty-viewer-prompt">
              <p>No file selected</p>
            </div>
          {/if}
        </div>
      </div>

      <!-- Live AST JSON KeyPath Query Widget -->
      <div class="widget-card glass-panel">
        <div class="widget-header">
          <div class="widget-title">
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Structured AST JSON KeyPath Query</span>
          </div>
        </div>

        <form class="query-form" onsubmit={handleExecuteJsonQuery}>
          <div class="query-input-group">
            <input
              type="text"
              bind:value={jsonKeyPath}
              placeholder="e.g. $.targets[0].id, sector, status"
              class="query-input font-mono"
            />
            <button type="submit" class="btn-primary btn-sm" disabled={!selectedFilePath}>
              Query KeyPath
            </button>
          </div>
          <span class="field-hint">Query active file without eval: dot-path, brackets, or empty for root.</span>
        </form>

        {#if jsonQueryError}
          <div class="query-error font-mono">{jsonQueryError}</div>
        {/if}

        {#if jsonQueryResult !== null && jsonQueryResult !== undefined}
          <div class="query-result-box">
            <span class="result-label">Result:</span>
            <pre class="font-mono">{JSON.stringify(jsonQueryResult, null, 2)}</pre>
          </div>
        {/if}
      </div>

      <!-- Regex Line Grep Widget -->
      <div class="widget-card glass-panel">
        <div class="widget-header">
          <div class="widget-title">
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Regex & Text Grep Search</span>
          </div>
        </div>

        <form class="query-form" onsubmit={handleExecuteGrep}>
          <div class="query-input-group">
            <input
              type="text"
              bind:value={grepPattern}
              placeholder="Search text or regex pattern across workspace files..."
              class="query-input font-mono"
            />
            <label class="regex-toggle">
              <input type="checkbox" bind:checked={grepIsRegex} />
              <span>Regex</span>
            </label>
            <button type="submit" class="btn-secondary btn-sm">
              Search Grep
            </button>
          </div>
        </form>

        {#if grepError}
          <div class="query-error font-mono">{grepError}</div>
        {/if}

        {#if grepResults}
          <div class="grep-results-box">
            <span class="result-label">Matches Found ({grepResults.length}):</span>
            {#if grepResults.length === 0}
              <p class="text-muted">No matches found.</p>
            {:else}
              <div class="grep-list">
                {#each grepResults as match, idx (idx)}
                  <button type="button" class="grep-item font-mono" onclick={() => handleSelectFile(match.filePath)}>
                    <span class="grep-path">{match.filePath}:{match.lineNumber}</span>
                    <span class="grep-line">{match.lineContent}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<!-- Copy File Modal -->
{#if showCopyModal && copySrcFile}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) showCopyModal = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') showCopyModal = false; }}
  >
    <div class="file-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="copy-file-title">
      <h3 id="copy-file-title" class="modal-title">Copy / Duplicate File</h3>
      <form onsubmit={handleExecuteCopy} class="modal-form">
        <div class="form-group">
          <span class="form-label">Source File</span>
          <div class="source-info font-mono">
            <span>[{currentWorkspace}]</span> {copySrcFile.path}
          </div>
        </div>

        <div class="form-group">
          <label for="copy-dest-ws">Target Workspace <span class="req">*</span></label>
          <select id="copy-dest-ws" bind:value={copyDestWorkspace} class="input-field font-mono">
            {#each sandboxStore.allWorkspaces as wsId (wsId)}
              <option value={wsId}>{wsId === 'global' ? 'Global Shared (global)' : wsId}</option>
            {/each}
          </select>
        </div>

        <div class="form-group">
          <label for="copy-dest-path">Target File Path <span class="req">*</span></label>
          <input
            id="copy-dest-path"
            type="text"
            bind:value={copyDestPath}
            placeholder="/data_copy.json"
            class="input-field font-mono"
            required
          />
        </div>

        <label class="checkbox-label">
          <input type="checkbox" bind:checked={copyOverwrite} />
          <span>Overwrite destination if file already exists</span>
        </label>

        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick={() => showCopyModal = false}>
            Cancel
          </button>
          <button type="submit" class="btn-primary">
            Copy File
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- New File Modal -->
{#if showCreateModal}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) showCreateModal = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') showCreateModal = false; }}
  >
    <div class="file-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="create-file-title">
      <h3 id="create-file-title" class="modal-title">Create New File in [{currentWorkspace}]</h3>
      <form onsubmit={handleCreateFile} class="modal-form">
        <div class="form-group">
          <label for="new-path">File Path <span class="req">*</span></label>
          <input
            id="new-path"
            type="text"
            bind:value={newFilePath}
            placeholder="/example.json"
            class="input-field font-mono"
            required
          />
        </div>

        <div class="form-group">
          <label for="new-content">File Content</label>
          <textarea
            id="new-content"
            bind:value={newFileContent}
            rows="6"
            class="textarea-field font-mono"
          ></textarea>
        </div>

        {#if currentWorkspace === 'global'}
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={newFileReadOnly} />
            <span>Mark as Read-Only in Global Workspace</span>
          </label>
        {/if}

        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick={() => showCreateModal = false}>
            Cancel
          </button>
          <button type="submit" class="btn-primary">
            Save File
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .fs-explorer-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 1.25rem;
    gap: 1.25rem;
    overflow-y: auto;
    position: relative;
    transition: outline 0.15s;
  }

  .fs-explorer-container.dragging {
    outline: 2px dashed var(--accent-primary, #38bdf8);
    outline-offset: -4px;
  }

  /* Drag Drop Overlay */
  .drag-drop-overlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 80;
    pointer-events: none;
  }

  .drag-drop-card {
    background: var(--bg-secondary);
    border: 2px dashed var(--accent-primary);
    border-radius: 12px;
    padding: 2.5rem 3rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    text-align: center;
  }

  .drag-icon {
    color: var(--accent-primary);
  }

  .drag-drop-card h3 {
    margin: 0;
    font-size: 1.2rem;
    color: var(--text-primary);
  }

  .drag-drop-card p {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-secondary);
  }

  /* Archiving Notification Banner */
  .download-report-live-region.live-region-empty {
    position: absolute;
  }

  .download-report-banner {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.85rem 1rem;
    border-radius: 8px;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: var(--text-primary);
    animation: fadeIn 0.2s ease-out;
  }

  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .report-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .warning-icon {
    color: #f87171;
  }

  .report-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #fca5a5;
  }

  .btn-close-report {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }

  .btn-close-report:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.1);
  }

  .report-text {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0;
  }

  .report-failure-list {
    list-style: none;
    margin: 0;
    padding: 0.35rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 7.5rem;
    overflow-y: auto;
    background: rgba(15, 23, 42, 0.35);
    border-radius: 4px;
    font-size: 0.74rem;
    color: var(--text-secondary);
  }

  .report-failure-list li {
    word-break: break-all;
  }

  .failure-path {
    color: #fca5a5;
  }

  .failure-reason {
    color: var(--text-muted);
    margin-left: 0.35rem;
  }

  .report-actions {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.25rem;
  }

  /* Status Toast */
  .download-status-toast {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.85rem;
    background: var(--bg-surface-elevated, #1e293b);
    border: 1px solid var(--border-focus, #38bdf8);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 0.78rem;
    align-self: flex-start;
    animation: fadeIn 0.15s ease-out;
  }

  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-primary, #38bdf8);
  }

  .status-indicator.pulse {
    animation: pulse 1.2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.85); }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .workspace-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .workspace-pills {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .workspace-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .dropdown-wrapper {
    position: relative;
  }

  .btn-action-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .caret-icon {
    transition: transform 0.15s;
  }

  .btn-action-trigger.active .caret-icon {
    transform: rotate(180deg);
  }

  .action-dropdown-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 290px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.4rem 0;
    display: flex;
    flex-direction: column;
    z-index: 60;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
  }

  .menu-label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--text-muted);
    padding: 0.35rem 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.45rem 0.85rem;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }

  .dropdown-item:hover:not(:disabled) {
    background: var(--bg-surface-elevated);
    color: var(--text-primary);
  }

  .dropdown-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dropdown-item.text-danger {
    color: #f87171;
  }

  .dropdown-item.text-danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.15);
    color: #fca5a5;
  }

  .dropdown-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: 0.35rem 0;
  }

  .ws-pill {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.82rem;
    transition: all 0.15s;
  }

  .ws-pill:hover {
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .ws-pill.active {
    background: var(--accent-primary-subtle);
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    font-weight: 600;
  }

  .file-count {
    font-size: 0.7rem;
    background: var(--bg-base);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }

  /* Bulk Action Bar */
  .bulk-action-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.3);
    flex-wrap: wrap;
    gap: 0.6rem;
    animation: fadeIn 0.15s ease-out;
  }

  .bulk-info {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
    color: var(--accent-primary);
  }

  .bulk-count {
    font-weight: 700;
    background: var(--accent-primary-subtle);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }

  .bulk-buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn-danger {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #fca5a5;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-danger:hover {
    background: rgba(239, 68, 68, 0.35);
    border-color: #ef4444;
  }

  .btn-danger-ghost {
    background: transparent;
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #fca5a5;
    border-radius: 4px;
    padding: 0.25rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }

  .btn-danger-ghost:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: #ef4444;
  }

  .btn-text {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem 0.4rem;
  }

  .btn-text:hover {
    color: var(--text-primary);
  }

  .fs-main-panes {
    display: grid;
    grid-template-columns: 400px 1fr;
    gap: 1.25rem;
    align-items: start;
  }

  .file-list-pane {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: 750px;
    overflow-y: auto;
  }

  .pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .pane-title-group {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .pane-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .header-actions {
    display: flex;
    gap: 0.4rem;
  }

  .btn-text-action {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    font-size: 0.7rem;
    cursor: pointer;
    transition: all 0.12s;
  }

  .btn-text-action:hover:not(:disabled) {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
    background: var(--accent-primary-subtle);
  }

  .btn-text-action:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .empty-files {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .empty-actions {
    display: flex;
    gap: 0.6rem;
  }

  .drop-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  .files-table-wrapper {
    overflow-x: auto;
  }

  .files-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  .files-table th {
    text-align: left;
    padding: 0.4rem 0.5rem;
    color: var(--text-muted);
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border-subtle);
  }

  .file-row {
    cursor: pointer;
    transition: background 0.15s;
  }

  .file-row:hover {
    background: var(--bg-surface);
  }

  .file-row.selected {
    background: var(--bg-surface-elevated);
  }

  .file-row.checked {
    background: rgba(56, 189, 248, 0.08);
  }

  .file-row td {
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .checkbox-cell {
    width: 28px;
  }

  .file-path {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-primary);
  }

  .badge-readonly {
    font-size: 0.65rem;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
  }

  .badge-owner {
    font-size: 0.7rem;
    color: var(--text-secondary);
    background: var(--bg-surface);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }

  .action-cell {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .btn-icon-action {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
  }

  .btn-icon-action:hover {
    color: var(--accent-primary);
    background: var(--accent-primary-subtle);
  }

  .btn-delete-action:hover {
    color: var(--accent-danger);
    background: var(--accent-danger-subtle);
  }

  .right-panes {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .content-viewer-card, .widget-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .viewer-header, .widget-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .viewer-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .btn-viewer-action {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .widget-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .file-meta-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .file-active-path {
    font-weight: 600;
    color: var(--accent-primary);
    font-size: 0.9rem;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .viewer-body {
    background: var(--bg-base);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    min-height: 180px;
    max-height: 380px;
    overflow: auto;
  }

  .file-code {
    padding: 0.85rem;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .empty-viewer-prompt {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 180px;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .query-form {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .query-input-group {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .query-input {
    flex: 1;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.82rem;
  }

  .query-input:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .regex-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .field-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .query-error {
    color: #f87171;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    font-size: 0.78rem;
  }

  .query-result-box, .grep-results-box {
    background: var(--bg-base);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .result-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .query-result-box pre {
    font-size: 0.8rem;
    color: var(--accent-cyan);
    overflow-x: auto;
  }

  .grep-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-height: 200px;
    overflow-y: auto;
  }

  .grep-item {
    display: flex;
    gap: 0.6rem;
    padding: 0.3rem 0.5rem;
    background: var(--bg-surface);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
    text-align: left;
    width: 100%;
  }

  .grep-item:hover {
    background: var(--bg-surface-elevated);
  }

  .grep-path {
    color: var(--accent-primary);
    flex-shrink: 0;
  }

  .grep-line {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .modal-backdrop {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(12, 13, 14, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1.5rem;
  }

  .file-modal {
    width: 100%;
    max-width: 500px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .modal-title {
    font-size: 1.1rem;
    color: var(--text-primary);
  }

  .modal-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .source-info {
    font-size: 0.85rem;
    color: var(--accent-primary);
    padding: 0.4rem 0.6rem;
    background: var(--bg-base);
    border-radius: 4px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-group label, .form-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .input-field, .textarea-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .textarea-field {
    resize: vertical;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  .req {
    color: var(--accent-danger);
  }

  @media (max-width: 900px) {
    .fs-main-panes {
      grid-template-columns: 1fr;
    }
  }
</style>
