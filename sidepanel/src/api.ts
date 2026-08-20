/**
 * voidr-service access — every request rides the background `apiRequest`
 * proxy (Auth0 Bearer token lives in the background, never here).
 *
 * All loop-test endpoints are being built in parallel: every consumer here is
 * defensive against 404s / missing listing endpoints and degrades to manual
 * input or silent skip instead of breaking the panel.
 */

import type {
  LoopTestScenarioSummary,
  LoopTestStatusView,
  QuickRunReport,
  VoidrJourney,
  VerificationHandoff,
  VerificationStatusView,
  VerificationSummary,
} from './types';

interface ApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function apiRequest(endpoint: string, method = 'GET', data?: unknown): Promise<ApiResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'apiRequest', endpoint, method, data }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { success: false, error: 'Sem resposta do background' });
      });
    } catch (e) {
      resolve({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function normalizeVerification(raw: Record<string, unknown>): VerificationStatusView | null {
  const verificationId = raw.verificationId;
  if (typeof verificationId !== 'string') return null;
  return {
    verificationId,
    bindingId: String(raw.bindingId ?? ''),
    generation: String(raw.generation ?? ''),
    cycleNumber: Number(raw.cycleNumber ?? 1),
    status: String(raw.status ?? 'prepared') as VerificationStatusView['status'],
    lifecycleVersion: Number(raw.lifecycleVersion ?? 0),
    mission: String(raw.mission ?? ''),
    targetUrl: String(raw.targetUrl ?? ''),
    environment: String(raw.environment ?? 'local'),
    phases: Array.isArray(raw.phases) ? (raw.phases as VerificationStatusView['phases']) : [],
    artifactReady: raw.artifactReady === true || Boolean(raw.artifact),
    diagnosisReady: raw.diagnosisReady === true || Boolean(raw.diagnosis),
    billing:
      raw.billing && typeof raw.billing === 'object'
        ? (raw.billing as VerificationStatusView['billing'])
        : undefined,
    decision:
      raw.decision && typeof raw.decision === 'object'
        ? (raw.decision as Record<string, unknown>)
        : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
  };
}

export async function listVerifications(): Promise<VerificationSummary[]> {
  const res = await apiRequest('/verifications');
  if (!res.success) throw new ApiError(res.error || 'Falha ao listar Verifications');
  const body = unwrap(res.data);
  if (!Array.isArray(body)) return [];
  return body
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(normalizeVerification)
    .filter((item): item is VerificationSummary => item !== null);
}

export async function getVerificationStatus(
  verificationId: string,
): Promise<VerificationStatusView> {
  const res = await apiRequest(`/verifications/${encodeURIComponent(verificationId)}/status`);
  if (!res.success) throw new ApiError(res.error || 'Falha ao consultar Verification');
  const body = unwrap(res.data);
  const normalized =
    body && typeof body === 'object'
      ? normalizeVerification(body as Record<string, unknown>)
      : null;
  if (!normalized) throw new ApiError('Status de Verification inválido');
  return normalized;
}

export async function prepareVerification(input: {
  mission: string;
  targetUrl: string;
  applicationId?: string;
  environment?: string;
}): Promise<VerificationStatusView> {
  const res = await apiRequest('/verifications/prepare', 'POST', input);
  if (!res.success) throw new ApiError(res.error || 'Falha ao preparar Verification');
  const body = unwrap(res.data);
  const normalized =
    body && typeof body === 'object'
      ? normalizeVerification(body as Record<string, unknown>)
      : null;
  if (!normalized) throw new ApiError('Prepare retornou um contrato inválido');
  return normalized;
}

export async function handoffVerification(
  verification: VerificationStatusView,
): Promise<VerificationHandoff> {
  const res = await apiRequest(
    `/verifications/${encodeURIComponent(verification.verificationId)}/handoff`,
    'POST',
    {
      lifecycleVersion: verification.lifecycleVersion,
      idempotencyKey: `extension-handoff:${verification.generation}`,
      extensionInstanceId: chrome.runtime.id,
    },
  );
  if (!res.success) throw new ApiError(res.error || 'Falha no handoff para a extensão');
  const body = unwrap(res.data);
  if (!body || typeof body !== 'object') throw new ApiError('Handoff inválido');
  return body as unknown as VerificationHandoff;
}

/** Unwrap the { data: ... } envelope voidr-service usually applies (0–2 levels). */
function unwrap(payload: unknown): unknown {
  let current = payload;
  for (let depth = 0; depth < 2; depth += 1) {
    if (current && typeof current === 'object' && 'data' in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>).data;
    } else {
      break;
    }
  }
  return current;
}

export class ApiError extends Error {
  notAuthenticated: boolean;
  /** True when the journey IR does not exist yet (first cycle still compiling). */
  irNotReady: boolean;
  constructor(message: string, options: { irNotReady?: boolean } = {}) {
    super(message);
    this.notAuthenticated = /not authenticated|authentication expired/i.test(message);
    this.irNotReady = options.irNotReady ?? false;
  }
}

function normalizeScenario(raw: Record<string, unknown>): LoopTestScenarioSummary | null {
  const id = raw.id ?? raw._id ?? raw.scenarioId;
  if (!id) return null;
  const baseline = Array.isArray(raw.baselineSessionIds) ? raw.baselineSessionIds : undefined;
  const runs = Array.isArray(raw.runs) ? raw.runs : undefined;
  const lastRun =
    runs && runs.length > 0 ? (runs[runs.length - 1] as Record<string, unknown>) : null;
  return {
    id: String(id),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    status: typeof raw.status === 'string' ? raw.status : undefined,
    baselineSessionIds: baseline as string[] | undefined,
    // The service list endpoint reports `sessionsRecorded`; older/other shapes
    // may carry `sessionsCaptured` or just the baseline ids array.
    sessionsCaptured:
      typeof raw.sessionsRecorded === 'number'
        ? raw.sessionsRecorded
        : typeof raw.sessionsCaptured === 'number'
          ? raw.sessionsCaptured
          : baseline?.length,
    // Single-recording flow: scenarios expect exactly 1 baseline session
    // (legacy scenarios may still carry up to 3 — the card clamps upward).
    maxSessions: typeof raw.maxSessions === 'number' ? raw.maxSessions : 1,
    cycle: typeof raw.cycle === 'number' ? raw.cycle : runs?.length,
    lastVerdict:
      typeof raw.lastVerdict === 'string'
        ? raw.lastVerdict
        : lastRun && typeof lastRun.verdict === 'string'
          ? lastRun.verdict
          : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    hasPendingFixRequest: raw.hasPendingFixRequest === true || !!raw.pendingFixRequest,
  };
}

export type ListScenariosResult =
  | { kind: 'ok'; scenarios: LoopTestScenarioSummary[] }
  | { kind: 'empty' }
  | { kind: 'unauthenticated' }
  | { kind: 'error'; message: string };

/**
 * `GET /loop-test/scenarios` — distinguishes empty org vs auth vs real errors
 * so the UI can show the right copy (never collapse everything into
 * "listagem indisponível").
 */
export async function listScenarios(): Promise<ListScenariosResult> {
  const res = await apiRequest('/loop-test/scenarios');
  if (!res.success) {
    if (res.error && /not authenticated|authentication expired/i.test(res.error)) {
      return { kind: 'unauthenticated' };
    }
    return { kind: 'error', message: res.error || 'Falha ao listar loops' };
  }
  const body = unwrap(res.data);
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).scenarios)
      ? ((body as Record<string, unknown>).scenarios as unknown[])
      : null;
  if (!arr) return { kind: 'error', message: 'Resposta inesperada ao listar loops' };
  const scenarios = arr
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(normalizeScenario)
    .filter((s): s is LoopTestScenarioSummary => s !== null);
  return scenarios.length === 0 ? { kind: 'empty' } : { kind: 'ok', scenarios };
}

/** `GET /loop-test/scenarios/{id}/status` — live authoritative-cycle phase. */
export async function getScenarioStatus(scenarioId: string): Promise<LoopTestStatusView | null> {
  const res = await apiRequest(`/loop-test/scenarios/${encodeURIComponent(scenarioId)}/status`);
  if (!res.success) return null;
  const body = unwrap(res.data);
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  return {
    scenarioId: String(raw.scenarioId ?? scenarioId),
    name: typeof raw.name === 'string' ? raw.name : undefined,
    status: typeof raw.status === 'string' ? raw.status : 'recording',
    cycle: typeof raw.cycle === 'number' ? raw.cycle : 0,
    sessionsRecorded: typeof raw.sessionsRecorded === 'number' ? raw.sessionsRecorded : 0,
    maxSessions: typeof raw.maxSessions === 'number' ? raw.maxSessions : 1,
    hasPendingFixRequest: raw.hasPendingFixRequest === true,
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
    runs: Array.isArray(raw.runs) ? (raw.runs as LoopTestStatusView['runs']) : [],
    lastEvent:
      raw.lastEvent && typeof raw.lastEvent === 'object'
        ? (raw.lastEvent as LoopTestStatusView['lastEvent'])
        : null,
  };
}

/** Platform base URL (from background env) — used for deep-links. */
export async function getPlatformBaseUrl(): Promise<string> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'getPlatformUrl' }, (res) => {
        if (chrome.runtime.lastError || !res?.url) {
          resolve('https://platform.voidr.co');
          return;
        }
        resolve(String(res.url).replace(/\/$/, ''));
      });
    } catch {
      resolve('https://platform.voidr.co');
    }
  });
}

/** `GET /loop-test/scenarios/{id}` — optional detail for manually typed ids. */
export async function getScenario(scenarioId: string): Promise<LoopTestScenarioSummary | null> {
  const res = await apiRequest(`/loop-test/scenarios/${encodeURIComponent(scenarioId)}`);
  if (!res.success) return null;
  const body = unwrap(res.data);
  if (!body || typeof body !== 'object') return null;
  return normalizeScenario(body as Record<string, unknown>);
}

/**
 * `GET /loop-test/scenarios/{id}/journey` — the compiled + healed IR.
 * Only exists after the first hive run of the scenario.
 */
export async function getJourney(scenarioId: string): Promise<VoidrJourney> {
  const res = await apiRequest(`/loop-test/scenarios/${encodeURIComponent(scenarioId)}/journey`);
  if (!res.success) {
    const err = res.error || '';
    // 404 / "no compiled journey" = the first loop cycle (auto-dispatched right
    // after the recording) hasn't compiled the journey yet — a NORMAL transient
    // state, surfaced as a friendly waiting notice by the panel.
    if (/404|no compiled journey/i.test(err)) {
      throw new ApiError(
        'O primeiro ciclo ainda está compilando a jornada — tente novamente em instantes.',
        { irNotReady: true },
      );
    }
    throw new ApiError(err || 'Falha ao buscar a journey');
  }
  const body = unwrap(res.data);
  const journey =
    body && typeof body === 'object' && 'journey' in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).journey
      : body;
  if (
    !journey ||
    typeof journey !== 'object' ||
    !Array.isArray((journey as Record<string, unknown>).steps)
  ) {
    throw new ApiError('Resposta do serviço não contém uma journey válida.');
  }
  return journey as unknown as VoidrJourney;
}

/**
 * `POST /loop-test/scenarios/{id}/quick-runs` — ledger entry for the quick
 * run. Fully defensive: any failure only logs (the endpoint may not exist).
 */
export async function postQuickRun(scenarioId: string, report: QuickRunReport): Promise<boolean> {
  const res = await apiRequest(
    `/loop-test/scenarios/${encodeURIComponent(scenarioId)}/quick-runs`,
    'POST',
    report,
  );
  if (!res.success) {
    console.warn('[Voidr LoopTest] quick-run report not persisted:', res.error);
    return false;
  }
  return true;
}
