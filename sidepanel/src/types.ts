/**
 * Loop Test side panel — shared types.
 *
 * The IR types mirror voidr-hive/lib/replay/types.ts (VoidrJourney and
 * friends). They are duplicated here on purpose: the extension consumes the
 * IR as a wire format served by voidr-service
 * (GET /loop-test/scenarios/{id}/journey) and must not depend on the hive
 * workspace at build time.
 */

export type TargetKind =
  'testid' | 'id' | 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'xpath';

export interface VoidrTarget {
  kind?: TargetKind;
  /** Legacy name of `kind` — older IRs only carry this. */
  strategy?: TargetKind;
  /** Full Playwright locator expression rooted at `page`. */
  locator: string;
  confidence: number;
  source?: 'screenmap' | 'recorded';
  agreement?: { sessions: number; total: number };
}

export function targetKind(target: VoidrTarget): TargetKind {
  return target.kind ?? target.strategy ?? 'css';
}

export type VoidrStepKind = 'navigate' | 'click' | 'fill' | 'select' | 'check' | 'expect-url';

export interface VoidrStep {
  kind: VoidrStepKind;
  targets: VoidrTarget[];
  value?: string;
  /** When set, the fill value comes from this parameter (masked input). */
  param?: string;
  sourceTimeOffsetMs: number;
  description: string;
}

export interface VoidrParam {
  name: string;
  envVar: string;
  reason: 'masked-value' | 'sensitive-selector';
  selector: string;
}

export interface VoidrJourney {
  sessionId: string;
  sessionIds?: string[];
  applicationId: string | null;
  name: string;
  initialUrl: string;
  steps: VoidrStep[];
  params: VoidrParam[];
  urlMilestones: string[];
  generatedBy: 'recorder' | 'merge';
  meta?: {
    recordingStartedAt?: number;
    viewport?: { width: number; height: number };
    locale?: string;
    timezoneId?: string;
  };
  stats?: {
    totalActions: number;
    droppedActions: number;
    screenmapMatches: number;
    mergedSessions?: number;
  };
}

// ── Scenario listing (defensive shape — endpoint may not exist yet) ─────────

export interface LoopTestScenarioSummary {
  id: string;
  name?: string;
  status?: string;
  baselineSessionIds?: string[];
  sessionsCaptured?: number;
  maxSessions?: number;
  cycle?: number;
  runs?: unknown[];
  lastVerdict?: string;
  updatedAt?: string;
  hasPendingFixRequest?: boolean;
}

/** Shape returned by GET /loop-test/scenarios/:id/status (subset we use). */
export interface LoopTestStatusView {
  scenarioId: string;
  name?: string;
  status: string;
  cycle: number;
  sessionsRecorded: number;
  maxSessions: number;
  hasPendingFixRequest: boolean;
  conversationId?: string | null;
  runs?: Array<{
    runId: string;
    status: string;
    verdict?: string | null;
    failureClass?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    sessionId?: string | null;
  }>;
  lastEvent?: { content?: string; timestamp?: string | Date } | null;
}

// ── Quick-run reporting ──────────────────────────────────────────────────────

export type QuickRunVerdict = 'green' | 'failed';

export interface QuickRunStepReport {
  index: number;
  action: VoidrStepKind;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface QuickRunReport {
  startedAt: string;
  finishedAt: string;
  verdict: QuickRunVerdict;
  steps: QuickRunStepReport[];
}

export type StepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface StepProgress {
  index: number;
  kind: VoidrStepKind;
  description: string;
  /** Locator of the winning candidate (or best candidate while pending). */
  locator: string | null;
  status: StepStatus;
  error?: string;
  durationMs?: number;
}

// ── Verification HIL/1 + VAP/1 ─────────────────────────────────────────────

export type VerificationStatus =
  | 'prepared'
  | 'recording'
  | 'sealing'
  | 'artifact_ready'
  | 'diagnosing'
  | 'decision_required'
  | 'retesting'
  | 'confirmed'
  | 'open'
  | 'failed';

export interface VerificationPhase {
  id: string;
  state: 'pending' | 'active' | 'completed' | 'failed';
}

export interface VerificationStatusView {
  verificationId: string;
  bindingId: string;
  generation: string;
  cycleNumber: number;
  status: VerificationStatus;
  lifecycleVersion: number;
  mission: string;
  targetUrl: string;
  environment: string;
  phases: VerificationPhase[];
  artifactReady: boolean;
  diagnosisReady: boolean;
  billing?: {
    outcomeId: 'verify_loop_cycle';
    unit: 'completed_verification_cycle';
    credits: number;
    status: 'unreserved' | 'reserved' | 'settled' | 'disabled';
    settlementPoint: 'vap_and_cited_diagnosis_persisted';
  };
  decision?: Record<string, unknown> | null;
  updatedAt?: string;
  createdAt?: string;
}

export interface VerificationSummary extends VerificationStatusView {
  artifact?: unknown;
  diagnosis?: unknown;
}

export interface VerificationHandoff {
  verification: VerificationStatusView;
  duplicate: boolean;
  capability?: {
    token: string;
    expiresAt: string;
    transport: 'authorization_header';
  };
}
