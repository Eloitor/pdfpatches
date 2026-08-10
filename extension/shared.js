export const extensionApi = globalThis.browser ?? globalThis.chrome;

const RAW_MANIFEST_URL =
  "https://raw.githubusercontent.com/Eloitor/pdfpatches/main/extension/patches.json";
const encoder = new TextEncoder();
let manifestPromise = null;

function withoutHash(value) {
  const hash = value.indexOf("#");
  return hash < 0 ? value : value.slice(0, hash);
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

export function matchesUrl(pattern, value) {
  if (!pattern || !value) return false;
  return wildcardToRegExp(withoutHash(pattern)).test(withoutHash(value));
}

export function findDocument(manifest, url) {
  return (manifest?.documents ?? []).find((document) => {
    const patterns = document.urlPatterns ?? [document.urlPattern ?? document.url];
    return patterns.some((pattern) => matchesUrl(pattern, url));
  }) ?? null;
}

function validateManifest(value) {
  if (!value || !Array.isArray(value.documents)) {
    throw new Error("patch manifest has no documents array");
  }
  return value;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return validateManifest(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadManifest() {
  if (manifestPromise === null) {
    manifestPromise = (async () => {
      try {
        return await fetchJson(RAW_MANIFEST_URL);
      } catch {
        return fetchJson(extensionApi.runtime.getURL("patches.json"));
      }
    })();
  }
  try {
    return await manifestPromise;
  } catch (error) {
    // Permit a later popup/service-worker event to retry a transient fetch.
    manifestPromise = null;
    throw error;
  }
}

export function clientPatches(document, names = null) {
  const selected = names === null
    ? document.patches
    : document.patches.filter((patch) => names.includes(patch.name));
  return selected
    .filter((patch) => patch.type === "unified" && patch.supportedClientSide !== false)
    .map((patch) => ({ name: patch.name, data: encoder.encode(patch.content) }));
}

export function unsupportedPatches(document, names = null) {
  const selected = names === null
    ? document.patches
    : document.patches.filter((patch) => names.includes(patch.name));
  return selected.filter((patch) => patch.type !== "unified" || patch.supportedClientSide === false);
}
