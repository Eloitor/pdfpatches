import {
  clientPatches,
  extensionApi,
  findDocument,
  loadManifest,
} from "./shared.js";

const documentElement = document.querySelector("#document");
const patchesElement = document.querySelector("#patches");
const messageElement = document.querySelector("#message");
const applyButton = document.querySelector("#apply");
let activeTab = null;
let matchedDocument = null;

function setMessage(message, isError = true) {
  messageElement.textContent = message;
  messageElement.style.color = isError ? "#b45309" : "#15803d";
}

function renderDocument(documentInfo) {
  documentElement.textContent = `${documentInfo.title}${documentInfo.author ? ` — ${documentInfo.author}` : ""}`;
  for (const patch of documentInfo.patches) {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.patchName = patch.name;
    checkbox.checked = patch.type === "unified" && patch.supportedClientSide !== false;
    checkbox.disabled = patch.type !== "unified" || patch.supportedClientSide === false;
    const text = document.createElement("code");
    text.textContent = patch.name;
    label.append(checkbox, text);
    if (checkbox.disabled) {
      item.classList.add("unsupported");
      item.title = "This patch is for the Python pipeline and is not executable in an extension.";
    }
    item.append(label);
    patchesElement.append(item);
  }
  applyButton.disabled = clientPatches(documentInfo).length === 0;
}

async function initialise() {
  const requestedTabId = Number.parseInt(new URLSearchParams(location.search).get("tabId"), 10);
  if (Number.isInteger(requestedTabId) && requestedTabId > 0) {
    activeTab = await extensionApi.tabs.get(requestedTabId);
  } else {
    const tabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0] ?? null;
  }
  const url = activeTab?.url ?? "";
  const manifest = await loadManifest();
  matchedDocument = findDocument(manifest, url);
  if (matchedDocument === null) {
    documentElement.textContent = "No patch manifest entry matches this tab.";
    applyButton.disabled = true;
    return;
  }
  renderDocument(matchedDocument);
}

applyButton.addEventListener("click", async () => {
  if (!activeTab || !matchedDocument) return;
  applyButton.disabled = true;
  setMessage("Downloading and patching in memory…", false);
  const names = [...patchesElement.querySelectorAll("input:checked")].map(
    (element) => element.dataset.patchName,
  );
  try {
    const response = await extensionApi.runtime.sendMessage({
      type: "apply-patches",
      tabId: activeTab.id,
      url: activeTab.url,
      documentId: matchedDocument.id,
      patchNames: names,
    });
    if (!response?.ok) throw new Error(response?.error ?? "patch failed");
    setMessage("Patched PDF opened.", false);
    setTimeout(() => window.close(), 250);
  } catch (error) {
    setMessage(error?.message ?? String(error));
    applyButton.disabled = false;
  }
});

void initialise().catch((error) => {
  documentElement.textContent = "Could not load the patch manifest.";
  setMessage(error?.message ?? String(error));
});
