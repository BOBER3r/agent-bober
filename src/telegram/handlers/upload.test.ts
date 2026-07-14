/**
 * upload.test.ts — Unit tests for the per-upload opt-in gate.
 * All tests use injected spies; no grammy, no network, no real medical pipeline.
 * Mirrors approvals.test.ts + capture.test.ts for style and assertion approach.
 */
import { describe, expect, it } from "vitest";

import { encodeCallback } from "../keyboard.js";
import { parseAllowedUsers } from "../whitelist.js";
import {
  LOCAL_INGEST_DEST,
  buildUploadPrompt,
  createPendingUploadState,
  handleUploadCallback,
  registerUpload,
} from "./upload.js";
import type { DownloadFn, MedicalIngest } from "./upload.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const ALLOWED = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "42" });

/** Spy factory for the ingest fn — records paths, returns fixture counts. */
function spyIngest(): { fn: MedicalIngest; calls: string[] } {
  const calls: string[] = [];
  const fn: MedicalIngest = async (p) => {
    calls.push(p);
    return { recordsParsed: 7, newRows: 5 };
  };
  return { fn, calls };
}

/** Spy factory for the download fn — records (fileId, destPath) pairs, no-op. */
function spyDownload(): { fn: DownloadFn; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn: DownloadFn = async (id, dest) => {
    calls.push([id, dest]);
  };
  return { fn, calls };
}

// ── sc-5-2: No confirmation → zero ingest calls ───────────────────────

describe("sc-5-2: no confirmation never invokes ingest", () => {
  it("registerUpload stashes the upload but does NOT invoke ingest or download", () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });

    // No callback was ever fired — both spies must be at zero calls
    expect(ingest.calls).toEqual([]);
    expect(dl.calls).toEqual([]);
  });

  it("stashed entry is present in pending map after registerUpload", () => {
    const pending = createPendingUploadState();
    registerUpload({ uploadId: "99", chatId: 7, fileId: "F2", fileName: "report.pdf", pending });
    expect(pending.has("99")).toBe(true);
    expect(pending.get("99")?.fileId).toBe("F2");
  });
});

// ── sc-5-3: Explicit Yes → download + ingest exactly once ─────────────

describe("sc-5-3: explicit Yes calls ingest exactly once with the downloaded file", () => {
  it("downloads then invokes ingest once with the downloaded path", async () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });

    const res = await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("confirm", "1"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    // Download was invoked exactly once with the correct file_id
    expect(dl.calls).toHaveLength(1);
    expect(dl.calls[0]![0]).toBe("F");

    // Ingest was invoked exactly once with the downloaded dest path
    expect(ingest.calls).toHaveLength(1);
    expect(ingest.calls[0]).toBe(dl.calls[0]![1]);

    // Reply is a count/summary (not null)
    expect(res.reply).toMatch(/Imported \d+/);
  });

  it("stash entry is consumed after Yes (single-shot — duplicate tap is a no-op)", async () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });

    await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("confirm", "1"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    // Stash must be empty after confirmation
    expect(pending.size).toBe(0);

    // Second tap on the same uploadId must not invoke ingest again
    const ingest2 = spyIngest();
    const dl2 = spyDownload();
    const res2 = await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("confirm", "1"),
      pending,
      download: dl2.fn,
      ingest: ingest2.fn,
    });
    expect(ingest2.calls).toEqual([]);
    expect(dl2.calls).toEqual([]);
    expect(res2.answer).toBe("Gone");
  });
});

// ── sc-5-4: No (cancel) → zero ingest calls + file discarded ──────────

describe("sc-5-4: No discards the upload and never invokes ingest", () => {
  it("cancel callback: zero ingest calls, zero download calls, stash cleared", async () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });

    await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("cancel", "1"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    // No ingest, no download
    expect(ingest.calls).toEqual([]);
    expect(dl.calls).toEqual([]);
    // Stash was consumed (discarded)
    expect(pending.size).toBe(0);
  });

  it("cancel callback returns a non-null reply confirming discard", async () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "2", chatId: 7, fileId: "G", fileName: "results.xml", pending });

    const res = await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("cancel", "2"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    expect(res.reply).not.toBeNull();
    expect(res.reply?.toLowerCase()).toContain("discard");
  });
});

// ── sc-5-5: Prompt discloses destination; reply is count-only ─────────

describe("sc-5-5: prompt names local ingest destination; reply leaks no marker values", () => {
  it("buildUploadPrompt contains LOCAL_INGEST_DEST and discloses non-E2E Telegram", () => {
    const prompt = buildUploadPrompt("labs.pdf");

    // Must name the local ingest destination BEFORE confirmation
    expect(prompt).toContain(LOCAL_INGEST_DEST);
    // Must disclose the non-E2E nature of Telegram so consent is informed
    expect(prompt.toLowerCase()).toContain("not end-to-end");
  });

  it("post-ingest reply is a count/summary starting with 'Imported N' (no decimal marker values)", async () => {
    const ingest = spyIngest(); // returns { recordsParsed: 7, newRows: 5 }
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });

    const res = await handleUploadCallback({
      senderId: 42,
      allowed: ALLOWED,
      data: encodeCallback("confirm", "1"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    // Reply must start with "Imported N" — count/summary only
    expect(res.reply).toMatch(/^Imported \d+/);

    // Must NOT echo decimal values that could leak marker levels (e.g. "3.4" or "12.5")
    expect(res.reply).not.toMatch(/\d+\.\d+/);

    // Must NOT contain words that suggest raw lab values were echoed
    const reply = res.reply ?? "";
    expect(reply.toLowerCase()).not.toContain("mmol");
    expect(reply.toLowerCase()).not.toContain("mg/dl");
  });

  it("non-whitelisted callback returns null reply and Denied answer without invoking ingest", async () => {
    const ingest = spyIngest();
    const dl = spyDownload();
    const pending = createPendingUploadState();

    registerUpload({ uploadId: "3", chatId: 7, fileId: "H", fileName: "data.xml", pending });

    const res = await handleUploadCallback({
      senderId: 999, // NOT in ALLOWED
      allowed: ALLOWED,
      data: encodeCallback("confirm", "3"),
      pending,
      download: dl.fn,
      ingest: ingest.fn,
    });

    expect(res.reply).toBeNull();
    expect(res.answer).toBe("Denied");
    expect(ingest.calls).toEqual([]);
    expect(dl.calls).toEqual([]);
  });
});
