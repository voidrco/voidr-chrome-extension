/**
 * Quick-run engine: interprets VoidrJourney IR steps directly against a live
 * tab, through the swappable QuickRunDriver (playwright-crx today).
 *
 * Contract (architecture §3 Etapa 5, quick-run mode):
 *  - candidates are tried best-first until one resolves — mirror of the
 *    compiled `resolveTarget`;
 *  - per-step budget 10s, whole-run budget 3min, Cancel at any time;
 *  - NO recording (the collector is never injected) and no comparison:
 *    verdict = all-steps-green vs first failure;
 *  - masked inputs come from an in-memory secrets map — never persisted,
 *    never logged, never sent anywhere;
 *  - run state is mirrored in chrome.storage.session so a re-opened panel
 *    can detect and clean up a stale debugger attachment (MV3 pattern).
 */

import type {
  QuickRunReport,
  QuickRunStepReport,
  StepProgress,
  VoidrJourney,
  VoidrStep,
} from '../types';
import { parseLocatorExpression } from './locator-parser';
import { urlMilestonePattern } from './url-pattern';
import type { DriverPage, DriverTarget, QuickRunDriver } from './driver';

export const STEP_TIMEOUT_MS = 10_000;
export const RUN_TIMEOUT_MS = 3 * 60_000;
const CANDIDATE_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 15_000;

const RUN_STATE_KEY = 'voidrQuickRunState';

export interface QuickRunState {
  scenarioId: string;
  status: 'running' | 'finished' | 'cancelled' | 'failed';
  stepIndex: number;
  tabId: number | null;
  startedAt: number;
  updatedAt: number;
}

export async function readRunState(): Promise<QuickRunState | null> {
  try {
    const res = await chrome.storage.session.get([RUN_STATE_KEY]);
    return (res?.[RUN_STATE_KEY] as QuickRunState) || null;
  } catch {
    return null;
  }
}

async function writeRunState(state: QuickRunState | null): Promise<void> {
  try {
    if (state) await chrome.storage.session.set({ [RUN_STATE_KEY]: state });
    else await chrome.storage.session.remove([RUN_STATE_KEY]);
  } catch {
    /* session storage is best-effort mirroring */
  }
}

export class RunCancelledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RunCancelledError';
  }
}

export class CancelToken {
  private reason: string | null = null;

  cancel(reason = 'Cancelado pelo usuário'): void {
    if (!this.reason) this.reason = reason;
  }

  get cancelled(): boolean {
    return this.reason !== null;
  }

  throwIfCancelled(): void {
    if (this.reason) throw new RunCancelledError(this.reason);
  }
}

export interface QuickRunCallbacks {
  onSteps(steps: StepProgress[]): void;
}

export interface QuickRunResult {
  report: QuickRunReport;
  cancelled: boolean;
  tabId: number;
}

function initialProgress(journey: VoidrJourney): StepProgress[] {
  return journey.steps.map((step, index) => ({
    index,
    kind: step.kind,
    description: step.description,
    locator: step.targets[0]?.locator ?? null,
    status: 'pending' as const,
  }));
}

/** Best-first candidate order — confidence desc, stable on ties. */
function rankedTargets(step: VoidrStep) {
  return [...step.targets].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

async function resolveTarget(
  page: DriverPage,
  step: VoidrStep,
  deadline: number,
  cancel: CancelToken,
): Promise<{ target: DriverTarget; locator: string }> {
  const misses: string[] = [];
  for (const candidate of rankedTargets(step)) {
    cancel.throwIfCancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const parsed = parseLocatorExpression(candidate.locator);
    if (!parsed) {
      misses.push(`${candidate.locator} (não interpretável)`);
      continue;
    }
    const target = await page.resolveCandidate(parsed, Math.min(CANDIDATE_TIMEOUT_MS, remaining));
    if (target) return { target, locator: candidate.locator };
    misses.push(candidate.locator);
  }
  throw new Error(
    misses.length > 0
      ? `Nenhum candidato de seletor resolveu um elemento visível (tentados: ${misses.join(' · ')})`
      : 'Passo sem candidatos de seletor no IR',
  );
}

/**
 * Fill values never appear in errors or progress: a masked step that fails
 * reports the locator, never the value.
 */
function resolveFillValue(step: VoidrStep, secrets: ReadonlyMap<string, string>): string {
  if (step.param) {
    const value = secrets.get(step.param);
    if (value === undefined || value === '') {
      throw new Error(
        `Valor do segredo "${step.param}" não informado — preencha antes de rodar o quick run.`,
      );
    }
    return value;
  }
  return step.value ?? '';
}

async function executeStep(
  page: DriverPage,
  step: VoidrStep,
  secrets: ReadonlyMap<string, string>,
  cancel: CancelToken,
): Promise<{ locator: string | null }> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;

  switch (step.kind) {
    case 'navigate':
      await page.goto(step.value ?? '', NAVIGATION_TIMEOUT_MS);
      return { locator: null };

    case 'expect-url':
      await page.waitForUrl(urlMilestonePattern(step.value ?? ''), STEP_TIMEOUT_MS);
      return { locator: null };

    case 'click': {
      const { target, locator } = await resolveTarget(page, step, deadline, cancel);
      await target.click(Math.max(deadline - Date.now(), 1000));
      return { locator };
    }

    case 'fill': {
      const value = resolveFillValue(step, secrets);
      const { target, locator } = await resolveTarget(page, step, deadline, cancel);
      await target.fill(value, Math.max(deadline - Date.now(), 1000));
      return { locator };
    }

    case 'select': {
      const { target, locator } = await resolveTarget(page, step, deadline, cancel);
      await target.selectOption(step.value ?? '', Math.max(deadline - Date.now(), 1000));
      return { locator };
    }

    case 'check': {
      const { target, locator } = await resolveTarget(page, step, deadline, cancel);
      await target.setChecked(step.value !== 'false', Math.max(deadline - Date.now(), 1000));
      return { locator };
    }

    default:
      throw new Error(`Tipo de passo desconhecido no IR: ${(step as VoidrStep).kind}`);
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Reuse a tab already sitting on the journey's app (same origin), else open one. */
async function openOrReuseTab(startUrl: string): Promise<number> {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    const match = tabs.find((t) => t.url && sameOrigin(t.url, startUrl));
    if (match?.id) {
      await chrome.tabs.update(match.id, { active: true });
      return match.id;
    }
  } catch {
    /* fall through to create */
  }
  const created = await chrome.tabs.create({ url: startUrl, active: true });
  if (!created.id) throw new Error('Não foi possível abrir a aba do quick run');
  // Give the fresh tab a moment to commit its first navigation before the
  // debugger attaches (attach on about:blank is fine, this is just niceness).
  await new Promise((r) => setTimeout(r, 500));
  return created.id;
}

/**
 * Reattach guard: if a previous run died mid-flight (panel closed, extension
 * reloaded), its tab may still hold a chrome.debugger attachment.
 */
export async function cleanupStaleRun(
  forceRelease: (tabId: number) => Promise<void>,
): Promise<QuickRunState | null> {
  const stale = await readRunState();
  if (stale && stale.status === 'running') {
    if (Number.isInteger(stale.tabId)) await forceRelease(stale.tabId as number);
    await writeRunState({ ...stale, status: 'failed', updatedAt: Date.now() });
    return stale;
  }
  return stale;
}

export async function runQuickRun(
  driver: QuickRunDriver,
  scenarioId: string,
  journey: VoidrJourney,
  secrets: ReadonlyMap<string, string>,
  cancel: CancelToken,
  callbacks: QuickRunCallbacks,
): Promise<QuickRunResult> {
  const startedAtMs = Date.now();
  const progress = initialProgress(journey);
  const stepReports: QuickRunStepReport[] = [];
  const emit = () => callbacks.onSteps(progress.map((p) => ({ ...p })));
  emit();

  const runTimer = setTimeout(
    () => cancel.cancel(`Tempo máximo do quick run excedido (${RUN_TIMEOUT_MS / 60000} min)`),
    RUN_TIMEOUT_MS,
  );

  let tabId: number | null = null;
  let verdict: QuickRunReport['verdict'] = 'green';
  let cancelled = false;

  try {
    if (!journey.initialUrl) throw new Error('Journey sem initialUrl — IR inválido.');
    tabId = await openOrReuseTab(journey.initialUrl);

    await writeRunState({
      scenarioId,
      status: 'running',
      stepIndex: -1,
      tabId,
      startedAt: startedAtMs,
      updatedAt: Date.now(),
    });

    const page = await driver.attach(tabId);

    // A reused same-origin tab may be sitting on ANY page of the app — always
    // start the run from the journey's entry point. (Idempotent for freshly
    // created tabs, which are already loading initialUrl.)
    await page.goto(journey.initialUrl, NAVIGATION_TIMEOUT_MS);

    for (let i = 0; i < journey.steps.length; i += 1) {
      cancel.throwIfCancelled();
      const step = journey.steps[i];
      const stepStart = Date.now();
      progress[i].status = 'running';
      emit();
      await writeRunState({
        scenarioId,
        status: 'running',
        stepIndex: i,
        tabId,
        startedAt: startedAtMs,
        updatedAt: Date.now(),
      });

      try {
        const { locator } = await executeStep(page, step, secrets, cancel);
        const durationMs = Date.now() - stepStart;
        progress[i].status = 'ok';
        progress[i].locator = locator ?? progress[i].locator;
        progress[i].durationMs = durationMs;
        stepReports.push({ index: i, action: step.kind, ok: true, durationMs });
        emit();
      } catch (err) {
        const durationMs = Date.now() - stepStart;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof RunCancelledError) {
          cancelled = true;
          progress[i].status = 'skipped';
          progress[i].error = message;
        } else {
          progress[i].status = 'failed';
          progress[i].error = message;
          stepReports.push({ index: i, action: step.kind, ok: false, error: message, durationMs });
        }
        for (let j = i + 1; j < progress.length; j += 1) progress[j].status = 'skipped';
        verdict = 'failed';
        emit();
        break;
      }
    }
  } catch (err) {
    // Failures before/outside the step loop (tab open, attach, cancel-between-steps).
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RunCancelledError) cancelled = true;
    verdict = 'failed';
    const runningIdx = progress.findIndex((p) => p.status === 'running' || p.status === 'pending');
    if (runningIdx >= 0) {
      progress[runningIdx].status = cancelled ? 'skipped' : 'failed';
      progress[runningIdx].error = message;
      for (let j = runningIdx + 1; j < progress.length; j += 1) progress[j].status = 'skipped';
    }
    emit();
  } finally {
    clearTimeout(runTimer);
    if (tabId !== null) {
      // Detach cleanly on finish/error/cancel — never leave the debugger banner up.
      await driver.detach(tabId).catch(() => {});
    }
    await writeRunState({
      scenarioId,
      status: cancelled ? 'cancelled' : verdict === 'green' ? 'finished' : 'failed',
      stepIndex: stepReports.length - 1,
      tabId,
      startedAt: startedAtMs,
      updatedAt: Date.now(),
    });
  }

  return {
    report: {
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      verdict,
      steps: stepReports,
    },
    cancelled,
    tabId: tabId ?? -1,
  };
}
