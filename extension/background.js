import { applyPdfPatches } from "./patcher.js";
import {
  clientPatches,
  extensionApi,
  findDocument,
  loadManifest,
  unsupportedPatches,
} from "./shared.js";

const pendingViewers = new Map();

async function documentForUrl(url) {
  if (!url || url.startsWith("blob:") || url.startsWith("chrome://")) return null;
  const manifest = await loadManifest();
  return { manifest, document: findDocument(manifest, url) };
}

async function updateBadge(tabId, url) {
  try {
    const match = await documentForUrl(url);
    const count = match?.document
      ? clientPatches(match.document).length
      : 0;
    await extensionApi.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
    if (count > 0) {
      await extensionApi.action.setBadgeBackgroundColor({ tabId, color: "#1967d2" });
    }
  } catch {
    await extensionApi.action.setBadgeText({ tabId, text: "" });
  }
}

async function refreshAllTabs() {
  const tabs = await extensionApi.tabs.query({});
  await Promise.all(tabs.map((tab) => updateBadge(tab.id, tab.url)));
}

async function createViewerFallback(bytes) {
  const viewer = await extensionApi.tabs.create({
    url: extensionApi.runtime.getURL("viewer.html"),
  });
  pendingViewers.set(viewer.id, bytes.slice().buffer);
  return viewer.id;
}

async function openPatchedPdf(tabId, bytes) {
  // Chrome currently exposes URL.createObjectURL in many extension service
  // workers, but Firefox and some Chromium versions do not.  In either case
  // the bytes stay in memory; the fallback viewer creates the blob URL in a
  // normal extension page.
  if (typeof globalThis.URL?.createObjectURL === "function") {
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    try {
      await extensionApi.tabs.update(tabId, { url: blobUrl });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return { mode: "service-worker-blob" };
    } catch {
      URL.revokeObjectURL(blobUrl);
    }
  }
  await createViewerFallback(bytes);
  return { mode: "viewer-page-blob" };
}

async function handleApply(message) {
  const tab = await extensionApi.tabs.get(message.tabId);
  const url = tab.url ?? message.url;
  const match = await documentForUrl(url);
  if (!match?.document) throw new Error("the active tab is not a patched document");

  const selectedNames = Array.isArray(message.patchNames) ? message.patchNames : null;
  const patches = clientPatches(match.document, selectedNames);
  if (patches.length === 0) throw new Error("no client-side unified patches were selected");

  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`could not download PDF (HTTP ${response.status})`);
  const source = new Uint8Array(await response.arrayBuffer());
  const result = await applyPdfPatches(source, patches);
  const viewer = await openPatchedPdf(tab.id, result.data);
  return {
    ok: true,
    strategy: result.strategy,
    results: result.results,
    viewer,
    skipped: unsupportedPatches(match.document, selectedNames).map((patch) => patch.name),
  };
}

extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") {
    void updateBadge(tabId, changeInfo.url ?? tab.url);
  }
});

extensionApi.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await extensionApi.tabs.get(tabId);
    await updateBadge(tabId, tab.url);
  } catch {
    // The tab can disappear between onActivated and tabs.get.
  }
});

extensionApi.runtime.onInstalled.addListener(() => void refreshAllTabs());
extensionApi.runtime.onStartup?.addListener(() => void refreshAllTabs());

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "apply-patches") {
    void handleApply(message).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: error?.message ?? String(error) }));
    return true;
  }

  if (message?.type === "viewer-ready") {
    let viewerTabId = message.tabId;
    if (viewerTabId === null || viewerTabId === undefined) {
      viewerTabId = pendingViewers.keys().next().value;
    }
    const data = pendingViewers.get(viewerTabId);
    pendingViewers.delete(viewerTabId);
    if (data === undefined) {
      sendResponse({ ok: false, error: "no in-memory patched PDF is pending" });
    } else {
      sendResponse({ ok: true, data });
    }
    return false;
  }

  return false;
});
