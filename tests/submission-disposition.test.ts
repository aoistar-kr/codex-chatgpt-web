import { expect, test } from "bun:test";

import {
  ChatGptCaptureDispositionTracker,
  ChatGptSubmissionDispositionTracker,
} from "../src/adapters/chatgpt-web/submission-disposition";

test("submission disposition preserves the no-replay ambiguity boundary", () => {
  const tracker = new ChatGptSubmissionDispositionTracker();
  expect(tracker.snapshot()).toBe("proved-not-started");

  tracker.sendActivated();
  expect(tracker.snapshot()).toBe("ambiguous");
  expect(() => tracker.sendActivated()).toThrow("invalid from submission disposition ambiguous");

  tracker.submitted();
  expect(tracker.snapshot()).toBe("committed");
  expect(() => tracker.proveRollback()).toThrow("committed ChatGPT submission cannot be rolled back");
});

test("only an explicit rollback proof makes an ambiguous in-turn retry safe again", () => {
  const tracker = new ChatGptSubmissionDispositionTracker();
  tracker.sendActivated();
  tracker.proveRollback();
  expect(tracker.snapshot()).toBe("proved-not-started");

  tracker.sendActivated();
  tracker.submitted();
  expect(tracker.snapshot()).toBe("committed");
});

test("semantic submission evidence cannot skip the Send ambiguity boundary", () => {
  const tracker = new ChatGptSubmissionDispositionTracker();
  expect(() => tracker.submitted()).toThrow("semantic submission evidence is invalid");
  expect(tracker.snapshot()).toBe("proved-not-started");
});

test("capture disposition is independent from submission replay safety", () => {
  const submission = new ChatGptSubmissionDispositionTracker();
  const capture = new ChatGptCaptureDispositionTracker();

  expect(() => capture.beginAfterCommit(submission.snapshot())).toThrow("cannot begin before submission commit");
  submission.sendActivated();
  expect(() => capture.beginAfterCommit(submission.snapshot())).toThrow("cannot begin before submission commit");

  submission.submitted();
  capture.beginAfterCommit(submission.snapshot());
  expect(capture.snapshot()).toBe("capturing");
  capture.complete();
  expect(capture.snapshot()).toBe("complete");

  capture.failAfterCommit(submission.snapshot());
  expect(capture.snapshot()).toBe("complete");
  expect(submission.snapshot()).toBe("committed");
});

test("capture loss after a committed prompt never rewinds it to replay-safe", () => {
  const submission = new ChatGptSubmissionDispositionTracker();
  submission.sendActivated();
  submission.submitted();

  const beforeObservation = new ChatGptCaptureDispositionTracker();
  beforeObservation.failAfterCommit(submission.snapshot());
  expect(beforeObservation.snapshot()).toBe("incomplete-after-commit");
  expect(submission.snapshot()).toBe("committed");

  const duringObservation = new ChatGptCaptureDispositionTracker();
  duringObservation.beginAfterCommit(submission.snapshot());
  duringObservation.failAfterCommit(submission.snapshot());
  expect(duringObservation.snapshot()).toBe("incomplete-after-commit");
  expect(submission.snapshot()).toBe("committed");
});

test("pre-submit failures do not invent incomplete-after-commit", () => {
  const submission = new ChatGptSubmissionDispositionTracker();
  const capture = new ChatGptCaptureDispositionTracker();
  capture.failAfterCommit(submission.snapshot());
  expect(capture.snapshot()).toBe("not-started");

  submission.sendActivated();
  capture.failAfterCommit(submission.snapshot());
  expect(capture.snapshot()).toBe("not-started");
});

test("capture can resume only from incomplete-after-commit and never rewinds submission replay safety", () => {
  const submission = new ChatGptSubmissionDispositionTracker();
  const capture = new ChatGptCaptureDispositionTracker();

  expect(() => capture.resumeAfterExactRecovery(submission.snapshot()))
    .toThrow("cannot resume before submission commit");
  submission.sendActivated();
  submission.submitted();
  expect(() => capture.resumeAfterExactRecovery(submission.snapshot()))
    .toThrow("cannot resume from disposition not-started");

  capture.beginAfterCommit(submission.snapshot());
  capture.failAfterCommit(submission.snapshot());
  expect(capture.snapshot()).toBe("incomplete-after-commit");
  capture.resumeAfterExactRecovery(submission.snapshot());
  expect(capture.snapshot()).toBe("capturing");
  expect(submission.snapshot()).toBe("committed");
  capture.complete();
  expect(capture.snapshot()).toBe("complete");
});
