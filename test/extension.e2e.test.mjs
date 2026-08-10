import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

let playwright = null;
try {
  playwright = await import("playwright");
} catch {
  // The repository does not require Playwright.  The test below remains a
  // ready-to-run check for environments that install it.
}

const fixture = ".work/sources/greenberg.pdf";

function browserAvailable() {
  if (playwright === null) return false;
  const { chromium } = playwright;
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

test(
  "MV3 extension E2E: badge, popup and local PDF render",
  { skip: !browserAvailable() || !existsSync(fixture) },
  async () => {
    const extensionSource = join(process.cwd(), "extension");
    const extensionDirectory = await mkdtemp(join(tmpdir(), "pdfpatches-extension-"));
    const profileDirectory = await mkdtemp(join(tmpdir(), "pdfpatches-chromium-"));
    const pdf = await readFile(fixture);
    const server = createServer((request, response) => {
      if (request.url === "/greenberg.pdf") {
        response.writeHead(200, { "content-type": "application/pdf" });
        response.end(pdf);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const pdfUrl = `http://127.0.0.1:${port}/greenberg.pdf`;
    const manifest = JSON.parse(await readFile(join(extensionSource, "patches.json"), "utf8"));
    const greenberg = manifest.documents.find((document) => document.id.startsWith("greenberg-"));
    greenberg.url = pdfUrl;
    greenberg.urlPattern = pdfUrl;
    greenberg.urlPatterns = [pdfUrl];
    manifest.documents = [greenberg];

    try {
      await cp(extensionSource, extensionDirectory, { recursive: true });
      await writeFile(join(extensionDirectory, "patches.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      const sharedPath = join(extensionDirectory, "shared.js");
      const shared = await readFile(sharedPath, "utf8");
      await writeFile(
        sharedPath,
        shared.replace(
          "https://raw.githubusercontent.com/Eloitor/pdfpatches/main/extension/patches.json",
          `http://127.0.0.1:${port}/not-a-manifest.json`,
        ),
      );

      const { chromium } = playwright;
      const context = await chromium.launchPersistentContext(profileDirectory, {
        headless: true,
        // channel "chromium" uses the full browser (new headless), which is
        // required for MV3 extensions; the default headless shell drops them.
        channel: "chromium",
        args: [
          `--disable-extensions-except=${extensionDirectory}`,
          `--load-extension=${extensionDirectory}`,
        ],
      });
      try {
        const serviceWorker = context.serviceWorkers()[0] ??
          await context.waitForEvent("serviceworker", { timeout: 10_000 });
        const pdfPage = await context.newPage();
        await pdfPage.goto(pdfUrl, { waitUntil: "load" });
        await pdfPage.waitForTimeout(500);
        const extensionId = new URL(serviceWorker.url()).host;
        const badge = await serviceWorker.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.url?.endsWith("/greenberg.pdf"));
          return tab ? chrome.action.getBadgeText({ tabId: tab.id }) : "";
        });
        assert.equal(badge, "3");

        const pdfTabId = await serviceWorker.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((candidate) => candidate.url?.endsWith("/greenberg.pdf"))?.id ?? -1;
        });
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${pdfTabId}`);
        await popup.waitForSelector("#apply:not([disabled])", { timeout: 10_000 });
        assert.equal(await popup.locator("#patches input:enabled").count(), 3);
        await popup.click("#apply");
        // The popup closes itself after applying; wait on Node's side instead.
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Applying the patch navigates the PDF tab to a blob URL, which closes
        // the original page object; poll for the patched viewer instead of
        // touching pdfPage.
        let patchedPage = null;
        for (let attempt = 0; attempt < 20 && patchedPage === null; attempt++) {
          patchedPage = context.pages().find((page) => page.url().startsWith("blob:")) ??
            context.pages().find((page) => page.url().endsWith("/viewer.html"));
          if (patchedPage === null) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        assert.ok(patchedPage, "the extension did not open a patched viewer");
        if (patchedPage.url().endsWith("/viewer.html")) {
          await patchedPage.waitForFunction(
            () => document.querySelector("#pdf")?.src.startsWith("blob:"),
            null,
            { timeout: 10_000 },
          );
        }
      } finally {
        await context.close();
      }
    } finally {
      server.close();
      await rm(extensionDirectory, { recursive: true, force: true });
      await rm(profileDirectory, { recursive: true, force: true });
    }
  },
);
