const api = globalThis.browser ?? globalThis.chrome;
const embed = document.querySelector("#pdf");
let blobUrl = null;

function showPdf(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer ?? data);
  const blob = new Blob([bytes], { type: "application/pdf" });
  blobUrl = URL.createObjectURL(blob);
  embed.src = blobUrl;
}

api.runtime.onMessage.addListener((message) => {
  if (message?.type === "patched-pdf") showPdf(message.data);
});

void api.tabs.getCurrent().then((tab) =>
  api.runtime.sendMessage({ type: "viewer-ready", tabId: tab?.id ?? null }),
).then((response) => {
  if (response?.ok) showPdf(response.data);
});

window.addEventListener("unload", () => {
  if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
});
