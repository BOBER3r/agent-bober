// ── Typed errors (host-side, build-time) ────────────────────────────

export class MissingKnobError extends Error {
  constructor(knob: string) {
    super(`Required workflow knob "${knob}" is unset; refusing to silently default.`);
    this.name = "MissingKnobError";
  }
}

export class AgentCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCapError";
  }
}

export class NonSerializableArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonSerializableArgError";
  }
}

export class WorkflowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowUnavailableError";
  }
}
