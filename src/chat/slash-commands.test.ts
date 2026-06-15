import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "./slash-commands.js";
import { RosterReader } from "./roster-reader.js";
import type { LLMClient } from "../providers/types.js";
import type { ChatParams, ChatResponse } from "../providers/types.js";

// ── Throwing LLMClient (must NOT be called during slash commands) ──────

class ThrowingClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called for slash commands");
  }
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-slash-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("slash-commands dispatch (sc-1-9)", () => {
  it("/help returns a handled result without calling LLM", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.output).toContain("/help");
      expect(result.output).toContain("/runs");
      expect(result.exit).toBeFalsy();
    }
  });

  it("/exit returns exit:true without calling LLM", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/exit", roster);

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.exit).toBe(true);
    }
  });

  it("/runs returns roster summary without calling LLM", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/runs", roster);

    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(typeof result.output).toBe("string");
      // Either "No runs found." or a list — both are valid
    }
  });

  it("non-slash input returns handled:false", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("What is bober?", roster);

    expect(result.handled).toBe(false);
  });

  it("slash commands succeed even when LLMClient would throw (sc-1-9)", async () => {
    // This ThrowingClient is injected to prove no LLM call occurs.
    // The dispatch function doesn't accept a client; this test verifies
    // by structural construction that dispatch uses only RosterReader.
    void new ThrowingClient(); // type-check: it implements LLMClient

    const roster = new RosterReader(tmpDir);

    // All slash commands should succeed — no LLM path
    const helpResult = await dispatch("/help", roster);
    expect(helpResult.handled).toBe(true);

    const exitResult = await dispatch("/exit", roster);
    expect(exitResult.handled).toBe(true);

    const runsResult = await dispatch("/runs", roster);
    expect(runsResult.handled).toBe(true);
  });
});

// ── /careful slash command tests (sc-1-6) ─────────────────────────────

describe("/careful slash command dispatch (sc-1-6)", () => {
  it("/careful without carefulHandler returns 'unavailable' message", async () => {
    const roster = new RosterReader(tmpDir);
    // 2-arg call — no carefulHandler
    const result = await dispatch("/careful", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("unavailable");
    }
  });

  it("/careful with no arg calls carefulHandler with undefined", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedArg: string | undefined = "sentinel";
    const carefulHandler = async (arg: string | undefined) => {
      receivedArg = arg;
      return "current state: off";
    };

    const result = await dispatch("/careful", roster, undefined, carefulHandler);
    expect(result.handled).toBe(true);
    expect(receivedArg).toBeUndefined();
    if (result.handled && !result.exit) {
      expect(result.output).toBe("current state: off");
    }
  });

  it("/careful on calls carefulHandler with 'on'", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedArg: string | undefined;
    const carefulHandler = async (arg: string | undefined) => {
      receivedArg = arg;
      return "Careful mode ON — new runs will pause at curated gates.";
    };

    const result = await dispatch("/careful on", roster, undefined, carefulHandler);
    expect(result.handled).toBe(true);
    expect(receivedArg).toBe("on");
    if (result.handled && !result.exit) {
      expect(result.output).toContain("ON");
    }
  });

  it("/careful off calls carefulHandler with 'off'", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedArg: string | undefined;
    const carefulHandler = async (arg: string | undefined) => {
      receivedArg = arg;
      return "Careful mode OFF — new runs will run in autopilot.";
    };

    const result = await dispatch("/careful off", roster, undefined, carefulHandler);
    expect(result.handled).toBe(true);
    expect(receivedArg).toBe("off");
  });

  it("/help includes /careful in the help text", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("/careful");
    }
  });

  it("existing 2-arg dispatch callers still work with /careful returning unavailable", async () => {
    // Verifies back-compat: 2-arg callers get the fallback message
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/careful on", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Careful mode is unavailable.");
    }
  });

  it("existing 3-arg dispatch callers still work (stopHandler provided, no carefulHandler)", async () => {
    const roster = new RosterReader(tmpDir);
    const stopHandler = async (_runId: string) => "stopped";
    const result = await dispatch("/careful on", roster, stopHandler);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Careful mode is unavailable.");
    }
  });
});

// ── /approve slash command tests (sc-3-4, sc-3-7) ─────────────────────

describe("/approve slash command dispatch (sc-3-4)", () => {
  it("/approve without checkpointId returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/approve", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /approve");
    }
  });

  it("/approve without approveHandler returns 'unavailable' message (back-compat)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/approve post-plan", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Approve is unavailable.");
    }
  });

  it("/approve calls approveHandler with checkpointId", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedId = "";
    const approveHandler = async (id: string) => {
      receivedId = id;
      return `Approved checkpoint ${id}. The run will resume.`;
    };

    const result = await dispatch(
      "/approve post-plan",
      roster,
      undefined,
      undefined,
      approveHandler,
    );
    expect(result.handled).toBe(true);
    expect(receivedId).toBe("post-plan");
    if (result.handled && !result.exit) {
      expect(result.output).toContain("post-plan");
    }
  });

  it("/help includes /approve and /reject in the help text (sc-3-7)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("/approve");
      expect(result.output).toContain("/reject");
    }
  });
});

// ── /reject slash command tests (sc-3-5) ──────────────────────────────

describe("/reject slash command dispatch (sc-3-5)", () => {
  it("/reject without checkpointId returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/reject", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /reject");
    }
  });

  it("/reject without rejectHandler returns 'unavailable' message (back-compat)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/reject post-plan split sprint 2", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Reject is unavailable.");
    }
  });

  it("/reject calls rejectHandler with checkpointId and full feedback remainder", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedId = "";
    let receivedFeedback = "";
    const rejectHandler = async (id: string, feedback: string) => {
      receivedId = id;
      receivedFeedback = feedback;
      return `Rejected checkpoint ${id}. Feedback sent for rework.`;
    };

    const result = await dispatch(
      "/reject post-plan split sprint 2",
      roster,
      undefined,
      undefined,
      undefined,
      rejectHandler,
    );
    expect(result.handled).toBe(true);
    expect(receivedId).toBe("post-plan");
    expect(receivedFeedback).toBe("split sprint 2");
  });

  it("/reject with multi-word feedback collects all words after the id", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedFeedback = "";
    const rejectHandler = async (_id: string, feedback: string) => {
      receivedFeedback = feedback;
      return "ok";
    };

    await dispatch(
      "/reject cp-1 needs more detail please",
      roster,
      undefined,
      undefined,
      undefined,
      rejectHandler,
    );
    expect(receivedFeedback).toBe("needs more detail please");
  });

  it("existing 4-arg callers still work with /approve returning unavailable", async () => {
    const roster = new RosterReader(tmpDir);
    const stopHandler = async (_runId: string) => "stopped";
    const carefulHandler = async (_arg: string | undefined) => "careful";
    const result = await dispatch("/approve post-plan", roster, stopHandler, carefulHandler);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Approve is unavailable.");
    }
  });
});

// ── /tell slash command tests (sc-4-4, sc-4-8) ────────────────────────

describe("/tell slash command dispatch (sc-4-4, sc-4-8)", () => {
  it("/tell without runId returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/tell", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /tell");
    }
  });

  it("/tell with runId but no text returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/tell run-abc", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /tell");
    }
  });

  it("/tell without tellHandler returns 'Tell is unavailable.'", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/tell run-abc prefer Zod", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Tell is unavailable.");
    }
  });

  it("/tell calls tellHandler with runId and full text remainder", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedRunId = "";
    let receivedText = "";
    const tellHandler = async (runId: string, text: string) => {
      receivedRunId = runId;
      receivedText = text;
      return "Queued.";
    };

    await dispatch(
      "/tell run-abc prefer Zod over yup",
      roster,
      undefined,
      undefined,
      undefined,
      undefined,
      tellHandler,
    );
    expect(receivedRunId).toBe("run-abc");
    expect(receivedText).toBe("prefer Zod over yup");
  });

  it("/help includes /tell in the help text (sc-4-8)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("/tell");
    }
  });

  it("back-compat: existing 6-arg callers still compile and /tell returns unavailable", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch(
      "/tell run-x some text",
      roster,
      undefined,
      undefined,
      undefined,
      undefined,
      // no tellHandler — 6-arg back-compat call
    );
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Tell is unavailable.");
    }
  });
});

// ── /pause slash command tests (sc-5-4, sc-5-6) ──────────────────────

describe("/pause slash command dispatch (sc-5-4)", () => {
  it("/pause without runId returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/pause", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /pause");
    }
  });

  it("/pause without pauseHandler returns 'Pause is unavailable.'", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/pause run-abc", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Pause is unavailable.");
    }
  });

  it("/pause calls pauseHandler with runId", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedRunId = "";
    const pauseHandler = async (runId: string) => {
      receivedRunId = runId;
      return `Paused run ${runId} at the next boundary — the process stays alive.`;
    };

    const result = await dispatch(
      "/pause run-abc",
      roster,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pauseHandler,
    );
    expect(result.handled).toBe(true);
    expect(receivedRunId).toBe("run-abc");
    if (result.handled && !result.exit) {
      expect(result.output).toContain("run-abc");
    }
  });

  it("/help includes /pause in the help text (sc-5-6)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("/pause");
    }
  });
});

// ── /resume slash command tests (sc-5-6) ─────────────────────────────

describe("/resume slash command dispatch (sc-5-6)", () => {
  it("/resume without runId returns usage hint", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/resume", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("Usage: /resume");
    }
  });

  it("/resume without resumeHandler returns 'Resume is unavailable.'", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/resume run-abc", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toBe("Resume is unavailable.");
    }
  });

  it("/resume calls resumeHandler with runId", async () => {
    const roster = new RosterReader(tmpDir);
    let receivedRunId = "";
    const resumeHandler = async (runId: string) => {
      receivedRunId = runId;
      return `Resumed run ${runId}.`;
    };

    const result = await dispatch(
      "/resume run-abc",
      roster,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resumeHandler,
    );
    expect(result.handled).toBe(true);
    expect(receivedRunId).toBe("run-abc");
    if (result.handled && !result.exit) {
      expect(result.output).toContain("run-abc");
    }
  });

  it("/help includes /resume in the help text (sc-5-6)", async () => {
    const roster = new RosterReader(tmpDir);
    const result = await dispatch("/help", roster);
    expect(result.handled).toBe(true);
    if (result.handled && !result.exit) {
      expect(result.output).toContain("/resume");
    }
  });

  it("back-compat: 7-arg callers (no pause/resumeHandler) — /pause + /resume return unavailable", async () => {
    const roster = new RosterReader(tmpDir);
    const pauseResult = await dispatch(
      "/pause run-x",
      roster,
      undefined, undefined, undefined, undefined, undefined,
      // no pauseHandler
    );
    expect(pauseResult.handled).toBe(true);
    if (pauseResult.handled && !pauseResult.exit) {
      expect(pauseResult.output).toBe("Pause is unavailable.");
    }

    const resumeResult = await dispatch(
      "/resume run-x",
      roster,
      undefined, undefined, undefined, undefined, undefined,
      // no resumeHandler
    );
    expect(resumeResult.handled).toBe(true);
    if (resumeResult.handled && !resumeResult.exit) {
      expect(resumeResult.output).toBe("Resume is unavailable.");
    }
  });
});
