export type SubmissionDisposition = "proved-not-started" | "ambiguous" | "committed";

export type CaptureDisposition =
  | "not-started"
  | "capturing"
  | "complete"
  | "incomplete-after-commit";

/**
 * Tracks only whether replaying the task prompt could be safe.
 *
 * Browser/DOM evidence remains authoritative. This state machine does not decide whether a send
 * happened; it records the existing ambiguity boundary, semantic acceptance evidence, and the one
 * explicit request-injection rollback proof that can make an in-turn retry safe again.
 */
export class ChatGptSubmissionDispositionTracker {
  private value: SubmissionDisposition = "proved-not-started";

  snapshot(): SubmissionDisposition {
    return this.value;
  }

  sendActivated(): void {
    if (this.value !== "proved-not-started") {
      throw new Error(`ChatGPT Send activation is invalid from submission disposition ${this.value}`);
    }
    this.value = "ambiguous";
  }

  submitted(): void {
    if (this.value !== "ambiguous") {
      throw new Error(`ChatGPT semantic submission evidence is invalid from disposition ${this.value}`);
    }
    this.value = "committed";
  }

  proveRollback(): void {
    if (this.value === "committed") {
      throw new Error("A committed ChatGPT submission cannot be rolled back for prompt replay");
    }
    if (this.value === "ambiguous") this.value = "proved-not-started";
  }
}

/**
 * Tracks response observation separately from prompt replay safety.
 *
 * A capture failure after semantic submission evidence never rewinds SubmissionDisposition and is
 * therefore represented explicitly as incomplete-after-commit rather than as a failed send.
 */
export class ChatGptCaptureDispositionTracker {
  private value: CaptureDisposition = "not-started";

  snapshot(): CaptureDisposition {
    return this.value;
  }

  beginAfterCommit(submission: SubmissionDisposition): void {
    if (submission !== "committed") {
      throw new Error(`ChatGPT response capture cannot begin before submission commit (${submission})`);
    }
    if (this.value !== "not-started") {
      throw new Error(`ChatGPT response capture cannot begin from disposition ${this.value}`);
    }
    this.value = "capturing";
  }

  complete(): void {
    if (this.value !== "capturing") {
      throw new Error(`ChatGPT response capture cannot complete from disposition ${this.value}`);
    }
    this.value = "complete";
  }

  failAfterCommit(submission: SubmissionDisposition): void {
    if (submission !== "committed" || this.value === "complete") return;
    this.value = "incomplete-after-commit";
  }

  /**
   * Synthetic H5 phase-2 transition only. A caller may resume observation after an incomplete
   * committed capture only after independently proving the exact same committed turn. This never
   * rewinds SubmissionDisposition and therefore never makes prompt replay safe.
   */
  resumeAfterExactRecovery(submission: SubmissionDisposition): void {
    if (submission !== "committed") {
      throw new Error(`ChatGPT response capture cannot resume before submission commit (${submission})`);
    }
    if (this.value !== "incomplete-after-commit") {
      throw new Error(`ChatGPT response capture cannot resume from disposition ${this.value}`);
    }
    this.value = "capturing";
  }
}
