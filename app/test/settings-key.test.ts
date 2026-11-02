// Copyright 2026 Trevor Baker, all rights reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Settings → AI "Test" key check against stale and hung responses (#264):
 *   - a result for a key that was edited away is dropped;
 *   - a superseded test can't overwrite the latest test's result;
 *   - a hung request is aborted after a bound, so Test re-enables.
 * `fetch` is stubbed with hand-settled deferreds; nothing reaches the network.
 * The key itself persists on commit (`change`), never per keystroke, and the
 * commits land in order (#278).
 */
/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock(
  "../src/platform/index.js",
  async () => (await import("./helpers/platform-mock.js")).platformModule,
);

import { platformMocks } from "./helpers/platform-mock.js";
import { installDomShims, resetHarness, flush, setValue } from "./helpers/editor-harness.js";
import { deferred, type Deferred } from "./helpers/deferred.js";

installDomShims();
const { openSettings } = await import("../src/settings.js");
const { messages } = await import("../src/i18n/index.js");
const s = messages.settings.ai;
const { GEMINI_API_KEY_SECRET } = await import("../src/autotrack.js");

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

describe("Settings API key persistence: saved on commit, in order (#278)", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    document.querySelector(".fl-modal-backdrop")?.remove();
  });

  it("doesn't save per keystroke; a change commits the trimmed key once", async () => {
    const { keyInput } = await openAiPanel();
    for (const partial of ["A", "AI", "AIz", "AIza "]) setValue(keyInput, partial);
    await flush();
    expect(platformMocks.setSecret).not.toHaveBeenCalled();

    keyInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(platformMocks.setSecret).toHaveBeenCalledTimes(1);
    expect(platformMocks.setSecret).toHaveBeenCalledWith(GEMINI_API_KEY_SECRET, "AIza");
  });

  it("clearing the field and committing deletes the stored key", async () => {
    const { keyInput } = await openAiPanel();
    setValue(keyInput, "", "change");
    await flush();
    expect(platformMocks.deleteSecret).toHaveBeenCalledWith(GEMINI_API_KEY_SECRET);
    expect(platformMocks.setSecret).not.toHaveBeenCalled();
  });

  it("commits land in order: a later save waits for the earlier one", async () => {
    const { keyInput } = await openAiPanel();
    const first = deferred<void>();
    platformMocks.setSecret.mockImplementationOnce(() => first.promise);

    setValue(keyInput, "short", "change");
    setValue(keyInput, "the-full-key", "change");
    await flush();
    expect(platformMocks.setSecret).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush();
    expect(platformMocks.setSecret).toHaveBeenCalledTimes(2);
    expect(platformMocks.setSecret.mock.calls.at(-1)).toEqual([
      GEMINI_API_KEY_SECRET,
      "the-full-key",
    ]);
  });

  it("closing the modal mid-edit blurs the key field so its change still commits", async () => {
    const { keyInput } = await openAiPanel();
    keyInput.focus();
    setValue(keyInput, "typed-then-escaped");
    const blurred = vi.fn();
    keyInput.addEventListener("blur", blurred);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(blurred).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".fl-modal-backdrop")).toBeNull();
  });

  it("the key test still reads the field's current value", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { keyInput, testBtn } = await openAiPanel();
      setValue(keyInput, "uncommitted-key"); // typed, never blurred
      testBtn.click();
      const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("uncommitted-key");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
