// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Settings → AI "Test" key check against stale and hung responses (#264):
 *   - a result for a key that was edited away is dropped;
 *   - a superseded test can't overwrite the latest test's result;
 *   - a hung request is aborted after a bound, so Test re-enables.
 * `fetch` is stubbed with hand-settled deferreds; nothing reaches the network.
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { installDomShims, resetHarness, flush, setValue } from "./helpers/editor-harness.js";
import { deferred, type Deferred } from "./helpers/deferred.js";

installDomShims();
const { openSettings } = await import("../src/settings.js");
const { messages } = await import("../src/i18n/index.js");
const s = messages.settings.ai;

/** Every fetch the key test makes, in call order, with its signal. */
let calls: Array<{ key: string; signal: AbortSignal | undefined; d: Deferred<Response> }>;

function okResponse(): Response {
  return new Response("{}", { status: 200 });
}
function badKeyResponse(): Response {
  return new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
    status: 400,
  });
}

async function openAiPanel(): Promise<{
  keyInput: HTMLInputElement;
  testBtn: HTMLButtonElement;
  status: HTMLElement;
}> {
  openSettings("ai");
  await flush(); // let the keychain hydration (getSecret → null) land first
  const main = document.querySelector<HTMLElement>(".fl-set-main")!;
  const keyInput = main.querySelector<HTMLInputElement>('input[type="password"]')!;
  const testBtn = [...main.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === s.apiKeyTest,
  )!;
  const status = main.querySelector<HTMLElement>(".fl-set-test")!;
  return { keyInput, testBtn, status };
}

describe("Settings key test — stale and hung responses (#264)", () => {
  beforeEach(() => {
    resetHarness();
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const d = deferred<Response>();
        const headers = init.headers as Record<string, string>;
        const signal = init.signal ?? undefined;
        signal?.addEventListener("abort", () =>
          d.reject(new DOMException("The operation was aborted.", "AbortError")),
        );
        calls.push({ key: headers["x-goog-api-key"]!, signal, d });
        return d.promise;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.querySelector(".fl-modal-backdrop")?.remove();
  });

  it("drops a result for a key that was edited away", async () => {
    const { keyInput, testBtn, status } = await openAiPanel();
    setValue(keyInput, "old-key");
    testBtn.click();
    expect(status.textContent).toBe(s.apiKeyTesting);

    setValue(keyInput, "new-key"); // edit the key while the test runs
    calls[0]!.d.resolve(okResponse());
    await flush();

    expect(status.textContent).not.toBe(s.apiKeyValid);
    expect(testBtn.disabled).toBe(false);
  });

  it("a superseded test can't overwrite the latest test's result", async () => {
    const { keyInput, testBtn, status } = await openAiPanel();
    setValue(keyInput, "the-key");
    testBtn.click(); // test #1
    setValue(keyInput, "other");
    setValue(keyInput, "the-key"); // back to the same key → Test re-enabled
    testBtn.click(); // test #2
    expect(calls).toHaveLength(2);

    calls[1]!.d.resolve(badKeyResponse()); // the latest test: invalid
    await flush();
    expect(status.textContent).toContain(s.apiKeyInvalid);

    calls[0]!.d.resolve(okResponse()); // the stale test lands last
    await flush();
    expect(status.textContent).toContain(s.apiKeyInvalid);
    expect(status.textContent).not.toBe(s.apiKeyValid);
  });

  it("aborts a hung request after the timeout and re-enables Test", async () => {
    const { keyInput, testBtn, status } = await openAiPanel();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setValue(keyInput, "the-key");
    testBtn.click();
    expect(testBtn.disabled).toBe(true);
    expect(calls[0]!.signal).toBeDefined();

    await vi.advanceTimersByTimeAsync(15_000);
    await flush();

    expect(calls[0]!.signal!.aborted).toBe(true);
    expect(testBtn.disabled).toBe(false);
    expect(status.textContent).toContain(s.apiKeyInvalid);
  });
});
