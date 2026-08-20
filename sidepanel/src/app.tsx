/**
 * Loop Test side panel — observatory for the authoritative cycle + advisory
 * Quick Run. The official verdict always comes from the harness (Cursor /
 * Claude Code via MCP); Quick Run is a local consultative replay only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  ApiError,
  getJourney,
  getPlatformBaseUrl,
  getScenario,
  getScenarioStatus,
  listScenarios,
  postQuickRun,
  type ListScenariosResult,
} from './api';
import type {
  LoopTestScenarioSummary,
  LoopTestStatusView,
  QuickRunReport,
  StepProgress,
  VoidrJourney,
  VoidrParam,
} from './types';
import { CrxQuickRunDriver, forceReleaseTab } from './runner/crx-driver';
import { CancelToken, cleanupStaleRun, runQuickRun } from './runner/quick-run';
import {
  CYCLE_STAGES,
  isInFlight,
  stageIndex,
  statusLabel,
  statusSummary,
  statusTone,
} from './status';
import { VerificationCycleController } from './verification-controller';

const PANEL_CONTEXT_KEY = 'voidrLoopTestPanelContext';

type Phase = 'idle' | 'loading-journey' | 'secrets' | 'running' | 'done';
type ListState = { kind: 'loading' } | ListScenariosResult;

const driver = new CrxQuickRunDriver();

function VoidrLogo() {
  return (
    <img class="header-logo" src={chrome.runtime.getURL('assets/logo-light.svg')} alt="Voidr" />
  );
}

function pillClass(tone: 'cyan' | 'green' | 'red' | 'dim') {
  if (tone === 'green') return 'pill pill-green';
  if (tone === 'red') return 'pill pill-red';
  if (tone === 'cyan') return 'pill pill-cyan';
  return 'pill pill-dim';
}

function openExternal(url: string) {
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function CycleStepper({ status }: { status?: string }) {
  const current = stageIndex(status);
  const flying = isInFlight(status);
  return (
    <div class="cycle-stepper" aria-hidden="true">
      {CYCLE_STAGES.map((stage, i) => {
        const done = current > i || status === 'green';
        const active = flying && current === i;
        return (
          <div
            key={stage.key}
            class={`cycle-stage ${done ? 'done' : ''} ${active ? 'active' : ''}`}
          >
            <span class="cycle-dot" />
            <span class="cycle-label">{stage.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProcessingCard({
  status,
  cycle,
  lastEvent,
}: {
  status?: string;
  cycle?: number;
  lastEvent?: { content?: string; timestamp?: string | Date } | null;
}) {
  return (
    <div class="processing-card">
      <div class="processing-head">
        <span class="spinner lg" />
        <div>
          <div class="processing-title">Em processamento</div>
          <div class="processing-sub">{statusSummary(status, cycle)}</div>
        </div>
      </div>
      <CycleStepper status={status} />
      {lastEvent?.content ? <div class="processing-ledger">{lastEvent.content}</div> : null}
    </div>
  );
}

function SessionPreview({ sessionId, platformBase }: { sessionId: string; platformBase: string }) {
  const url = `${platformBase}/user-monitoring/sessions/${encodeURIComponent(sessionId)}`;
  return (
    <button type="button" class="session-preview" onClick={() => openExternal(url)}>
      <div class="session-preview-visual" aria-hidden="true">
        <div class="session-preview-scan" />
        <span class="session-preview-play">▶</span>
      </div>
      <div class="session-preview-body">
        <div class="session-preview-title">Gravação baseline</div>
        <div class="session-preview-meta">Abrir replay na plataforma</div>
      </div>
    </button>
  );
}

function ScenarioSummary({
  scenario,
  live,
  platformBase,
}: {
  scenario: LoopTestScenarioSummary;
  live: LoopTestStatusView | null;
  platformBase: string;
}) {
  const status = live?.status ?? scenario.status;
  const cycle = live?.cycle ?? scenario.cycle;
  const tone = statusTone(status);
  const sessions =
    live?.sessionsRecorded ?? scenario.sessionsCaptured ?? scenario.baselineSessionIds?.length ?? 0;
  const baselineId = scenario.baselineSessionIds?.[0];
  const loopUrl = `${platformBase}/loops/${encodeURIComponent(scenario.id)}`;

  return (
    <div class="card summary-card">
      <div class="summary-top">
        <div class="summary-name">{scenario.name || 'Loop sem nome'}</div>
        <span class={pillClass(tone)}>{statusLabel(status)}</span>
      </div>
      <p class="summary-blurb">{statusSummary(status, cycle)}</p>
      <div class="summary-stats">
        <div>
          <span class="scenario-meta-label">Ciclo</span>
          <span class="scenario-meta-value">{typeof cycle === 'number' ? cycle : '—'}</span>
        </div>
        <div>
          <span class="scenario-meta-label">Gravação</span>
          <span class="scenario-meta-value">{sessions >= 1 ? 'Concluída' : 'Pendente'}</span>
        </div>
        <div>
          <span class="scenario-meta-label">Veredito</span>
          <span class="scenario-meta-value">
            {scenario.lastVerdict ? (
              <span class={pillClass(statusTone(scenario.lastVerdict))}>
                {statusLabel(scenario.lastVerdict)}
              </span>
            ) : (
              '—'
            )}
          </span>
        </div>
      </div>
      {baselineId && platformBase ? (
        <SessionPreview sessionId={baselineId} platformBase={platformBase} />
      ) : null}
      <button type="button" class="btn btn-ghost linkish" onClick={() => openExternal(loopUrl)}>
        Abrir na plataforma →
      </button>
    </div>
  );
}

function StepIcon({ status }: { status: StepProgress['status'] }) {
  if (status === 'running')
    return (
      <span class="step-icon">
        <span class="spinner" />
      </span>
    );
  if (status === 'ok') return <span class="step-icon ok">✓</span>;
  if (status === 'failed') return <span class="step-icon failed">✗</span>;
  if (status === 'skipped') return <span class="step-icon skipped">–</span>;
  return <span class="step-icon pending">○</span>;
}

function StepList({ steps }: { steps: StepProgress[] }) {
  return (
    <div class="steps">
      {steps.map((s) => (
        <div class={`step-row ${s.status}`} key={s.index}>
          <StepIcon status={s.status} />
          <div class="step-body">
            <div class="step-desc">
              {String(s.index + 1).padStart(2, '0')} — {s.description}
            </div>
            {s.error && s.status === 'failed' ? <div class="step-error">{s.error}</div> : null}
          </div>
          {typeof s.durationMs === 'number' ? (
            <span class="step-duration">{(s.durationMs / 1000).toFixed(1)}s</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SecretsForm({
  params,
  onSubmit,
  onCancel,
}: {
  params: VoidrParam[];
  onSubmit: (secrets: Map<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const allFilled = params.every((p) => (values[p.name] || '').length > 0);

  return (
    <div class="card">
      <div class="section-label">Segredos do fluxo</div>
      <p class="muted" style={{ fontSize: '11.5px', marginTop: 0 }}>
        Valores mascarados na gravação. Ficam só em memória neste replay — nunca são salvos.
      </p>
      {params.map((p) => (
        <div class="secret-field" key={p.name}>
          <label class="secret-label">{p.name}</label>
          <input
            type="password"
            autocomplete="off"
            placeholder={`Valor de ${p.name}`}
            value={values[p.name] || ''}
            onInput={(e) =>
              setValues((prev) => ({ ...prev, [p.name]: (e.target as HTMLInputElement).value }))
            }
          />
        </div>
      ))}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <button
          class="btn btn-primary"
          disabled={!allFilled}
          onClick={() => onSubmit(new Map(Object.entries(values)))}
        >
          Iniciar replay
        </button>
        <button class="btn" style={{ width: 'auto' }} onClick={onCancel}>
          Voltar
        </button>
      </div>
    </div>
  );
}

function HarnessHint({ status, platformBase }: { status?: string; platformBase: string }) {
  const connectUrl = `${platformBase}/loops`;
  if (status === 'fix_required') {
    return (
      <div class="harness-hint">
        <div class="harness-hint-title">Correção no harness</div>
        <p>
          O ciclo oficial pediu um fix. Peça ao seu agente (Cursor / Claude Code) para usar{' '}
          <code>loop_test_request_fix</code> e depois <code>loop_test_resolve_fix</code>.
        </p>
        <button
          type="button"
          class="btn btn-ghost linkish"
          onClick={() => openExternal(connectUrl)}
        >
          Ver evidências na plataforma →
        </button>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div class="harness-hint">
        <div class="harness-hint-title">Dispare pelo harness</div>
        <p>
          Peça ao agente conectado via MCP: <code>loop_test_run</code> e acompanhe com{' '}
          <code>loop_test_wait_for_status</code>.
        </p>
      </div>
    );
  }
  return (
    <div class="harness-hint quiet">
      <p>
        O veredito oficial vem do ciclo no harness (MCP). O replay rápido abaixo é só consultivo —
        não grava sessão nem altera o baseline.
      </p>
    </div>
  );
}

export function LegacyLoopTestApp() {
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string>('');
  const [manualId, setManualId] = useState<string>('');
  const [scenario, setScenario] = useState<LoopTestScenarioSummary | null>(null);
  const [liveStatus, setLiveStatus] = useState<LoopTestStatusView | null>(null);
  const [platformBase, setPlatformBase] = useState('https://platform.voidr.co');
  const [phase, setPhase] = useState<Phase>('idle');
  const [journey, setJourney] = useState<VoidrJourney | null>(null);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [report, setReport] = useState<QuickRunReport | null>(null);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [reportPosted, setReportPosted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [irState, setIrState] = useState<'waiting' | 'ready' | null>(null);
  const cancelRef = useRef<CancelToken | null>(null);

  const scenarioId = (selectedId || manualId).trim();
  const scenarios = listState.kind === 'ok' ? listState.scenarios : [];

  useEffect(() => {
    getPlatformBaseUrl().then(setPlatformBase);

    cleanupStaleRun(forceReleaseTab).then((stale) => {
      if (stale?.status === 'running') {
        setStaleNotice('Um replay anterior foi interrompido; a aba foi liberada.');
      }
    });

    chrome.storage.session
      .get([PANEL_CONTEXT_KEY])
      .then((res) => {
        const ctx = res?.[PANEL_CONTEXT_KEY] as { scenarioId?: string } | undefined;
        if (ctx?.scenarioId) {
          setSelectedId(ctx.scenarioId);
          setManualId(ctx.scenarioId);
        }
      })
      .catch(() => {});

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !changes[PANEL_CONTEXT_KEY]) return;
      const ctx = changes[PANEL_CONTEXT_KEY].newValue as { scenarioId?: string } | undefined;
      if (ctx?.scenarioId) {
        setSelectedId(ctx.scenarioId);
        setManualId(ctx.scenarioId);
      }
    };
    chrome.storage.onChanged.addListener(onStorage);

    listScenarios()
      .then((result) => {
        setListState(result);
        if (result.kind === 'unauthenticated') {
          setError('Conecte-se na extensão Voidr para ver seus loops.');
        }
      })
      .catch(() => setListState({ kind: 'error', message: 'Falha ao listar loops' }));

    return () => chrome.storage.onChanged.removeListener(onStorage);
  }, []);

  // Resolve scenario card + poll live status while in-flight / waiting for IR.
  useEffect(() => {
    setScenario(null);
    setLiveStatus(null);
    if (!scenarioId) return;

    const fromList = scenarios.find((s) => s.id === scenarioId);
    if (fromList) setScenario(fromList);

    let alive = true;
    const refresh = async () => {
      const [detail, status] = await Promise.all([
        getScenario(scenarioId),
        getScenarioStatus(scenarioId),
      ]);
      if (!alive) return;
      // Ghost ID (deleted loop still in session storage / manual input): clear
      // the fake "em processamento" state instead of polling forever.
      if (!detail && !status && !fromList) {
        setScenario(null);
        setLiveStatus(null);
        setIrState(null);
        setError(
          'Este loop não existe mais (foi excluído ou o ID é inválido). Escolha outro na lista ou crie um novo pelo harness.',
        );
        try {
          await chrome.storage.session.remove([PANEL_CONTEXT_KEY]);
        } catch {
          /* ignore */
        }
        return;
      }
      if (detail) {
        setScenario(detail);
      } else if (fromList) {
        setScenario(fromList);
      }
      if (status) {
        setLiveStatus(status);
        setScenario((prev) =>
          prev
            ? {
                ...prev,
                status: status.status,
                cycle: status.cycle,
                sessionsCaptured: status.sessionsRecorded,
                hasPendingFixRequest: status.hasPendingFixRequest,
                lastVerdict:
                  status.runs && status.runs.length > 0
                    ? (status.runs[status.runs.length - 1]?.verdict ?? prev.lastVerdict)
                    : prev.lastVerdict,
              }
            : prev,
        );
      }
    };

    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scenarioId, scenarios]);

  const startRun = useCallback(
    async (journeyToRun: VoidrJourney, secrets: Map<string, string>) => {
      setPhase('running');
      setReport(null);
      setReportPosted(null);
      setWasCancelled(false);
      setError(null);

      const cancel = new CancelToken();
      cancelRef.current = cancel;

      try {
        await cleanupStaleRun(forceReleaseTab);
        const result = await runQuickRun(driver, scenarioId, journeyToRun, secrets, cancel, {
          onSteps: setSteps,
        });
        setReport(result.report);
        setWasCancelled(result.cancelled);
        if (!result.cancelled) {
          const ok = await postQuickRun(scenarioId, result.report);
          setReportPosted(ok);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        secrets.clear();
        cancelRef.current = null;
        setPhase('done');
      }
    },
    [scenarioId],
  );

  const onQuickRun = useCallback(async () => {
    if (!scenarioId) return;
    setError(null);
    setIrState(null);
    setSteps([]);
    setReport(null);
    setPhase('loading-journey');
    try {
      const j = await getJourney(scenarioId);
      setJourney(j);
      if ((j.params?.length ?? 0) > 0) {
        setPhase('secrets');
      } else {
        await startRun(j, new Map());
      }
    } catch (e) {
      if (e instanceof ApiError && e.irNotReady) {
        setIrState('waiting');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase('idle');
    }
  }, [scenarioId, startRun]);

  useEffect(() => {
    if (irState !== 'waiting' || !scenarioId) return;
    let alive = true;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      try {
        await getJourney(scenarioId);
        if (!alive) return;
        setIrState('ready');
      } catch (e) {
        if (!alive) return;
        if (!(e instanceof ApiError && e.irNotReady)) {
          setIrState(null);
          setError(e instanceof Error ? e.message : String(e));
        } else if (attempts >= 60) {
          setIrState(null);
          setError('A jornada ainda não ficou pronta — acompanhe o loop na plataforma.');
        }
      }
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [irState, scenarioId]);

  // When live status leaves in-flight and journey becomes available, clear waiting.
  useEffect(() => {
    if (irState !== 'waiting') return;
    const st = liveStatus?.status;
    if (st === 'green' || st === 'fix_required' || st === 'failed') {
      getJourney(scenarioId)
        .then(() => setIrState('ready'))
        .catch(() => {});
    }
  }, [irState, liveStatus?.status, scenarioId]);

  const onCancel = useCallback(() => {
    cancelRef.current?.cancel();
  }, []);

  const durationLabel = useMemo(() => {
    if (!report) return null;
    const ms = new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
    return `${(ms / 1000).toFixed(1)}s`;
  }, [report]);

  const busy = phase === 'loading-journey' || phase === 'running';
  const currentStatus = liveStatus?.status ?? scenario?.status;
  const showProcessing = isInFlight(currentStatus) || irState === 'waiting';
  const quickRunReady =
    !showProcessing &&
    (irState === 'ready' ||
      currentStatus === 'green' ||
      currentStatus === 'fix_required' ||
      currentStatus === 'failed');

  return (
    <div class="panel">
      <div class="header">
        <VoidrLogo />
        <div class="header-text">
          <span class="header-title">Loop Test</span>
          <span class="header-sub">Observatório do ciclo</span>
        </div>
      </div>

      {staleNotice ? <div class="info-box">{staleNotice}</div> : null}

      <div>
        <div class="section-label">Seus loops</div>
        {listState.kind === 'loading' ? (
          <div class="muted row-loading">
            <span class="spinner" /> Carregando…
          </div>
        ) : listState.kind === 'ok' ? (
          <select
            value={selectedId}
            disabled={busy}
            onChange={(e) => {
              setSelectedId((e.target as HTMLSelectElement).value);
              setManualId('');
              setIrState(null);
              setError(null);
            }}
          >
            <option value="">Escolha um loop…</option>
            {scenarios.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name || s.id} · {statusLabel(s.status)}
              </option>
            ))}
          </select>
        ) : listState.kind === 'empty' ? (
          <div class="empty-card">
            <div class="empty-title">Nenhum loop ainda</div>
            <p class="muted">
              Crie o primeiro pelo harness (Cursor / Claude Code) com <code>loop_test_create</code>,
              ou pela plataforma em Loops.
            </p>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => openExternal(`${platformBase}/loops`)}
            >
              Abrir Loops na plataforma
            </button>
          </div>
        ) : listState.kind === 'unauthenticated' ? (
          <div class="empty-card">
            <div class="empty-title">Conecte-se</div>
            <p class="muted">Abra o ícone da extensão Voidr e faça login para ver seus loops.</p>
          </div>
        ) : (
          <div>
            <input
              type="text"
              placeholder="ID do loop (ex.: lts_…)"
              value={manualId}
              disabled={busy}
              onInput={(e) => {
                setManualId((e.target as HTMLInputElement).value);
                setSelectedId('');
              }}
            />
            <div class="muted" style={{ fontSize: '11px', marginTop: '6px' }}>
              {listState.kind === 'error'
                ? listState.message
                : 'Não foi possível listar — cole o ID do loop.'}
            </div>
          </div>
        )}
      </div>

      {scenario ? (
        <ScenarioSummary scenario={scenario} live={liveStatus} platformBase={platformBase} />
      ) : null}

      {error ? <div class="error-box">{error}</div> : null}

      {showProcessing ? (
        <ProcessingCard
          status={currentStatus}
          cycle={liveStatus?.cycle ?? scenario?.cycle}
          lastEvent={liveStatus?.lastEvent}
        />
      ) : null}

      {irState === 'ready' && !showProcessing ? (
        <div class="info-box">Jornada pronta — você pode rodar um replay rápido abaixo.</div>
      ) : null}

      {scenarioId ? <HarnessHint status={currentStatus} platformBase={platformBase} /> : null}

      {/* Quick run actions */}
      {(phase === 'idle' || phase === 'done') && scenarioId ? (
        <button
          class="btn btn-primary"
          disabled={!scenarioId || busy || showProcessing}
          onClick={onQuickRun}
          title={
            showProcessing
              ? 'Disponível quando o ciclo oficial terminar de compilar a jornada'
              : undefined
          }
        >
          {showProcessing ? 'Replay disponível em breve' : '▶ Replay rápido'}
        </button>
      ) : null}
      {phase === 'loading-journey' ? (
        <button class="btn" disabled>
          <span class="spinner" /> Preparando jornada…
        </button>
      ) : null}
      {phase === 'running' ? (
        <button class="btn btn-danger" onClick={onCancel}>
          ■ Cancelar
        </button>
      ) : null}

      {quickRunReady && phase === 'idle' && !journey ? (
        <p class="advisory-note">
          Replay no seu browser — feedback imediato. O veredito oficial continua sendo o do ciclo no
          harness.
        </p>
      ) : null}

      {phase === 'secrets' && journey ? (
        <SecretsForm
          params={journey.params}
          onSubmit={(secrets) => startRun(journey, secrets)}
          onCancel={() => setPhase('idle')}
        />
      ) : null}

      {steps.length > 0 && phase !== 'secrets' ? (
        <div class="card">
          <div class="section-label">Passos do replay</div>
          <StepList steps={steps} />
        </div>
      ) : null}

      {phase === 'done' && report ? (
        <div class={`verdict ${wasCancelled ? 'cancelled' : report.verdict}`}>
          <span>
            {wasCancelled
              ? '◼ Cancelado'
              : report.verdict === 'green'
                ? '✓ Replay ok'
                : '✗ Replay falhou'}
          </span>
          <span class="verdict-sub">
            {report.steps.filter((s) => s.ok).length}/{journey?.steps.length ?? report.steps.length}{' '}
            passos · {durationLabel}
            {reportPosted === true ? ' · registrado' : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const [legacyEnabled, setLegacyEnabled] = useState(false);
  useEffect(() => {
    chrome.storage.local
      .get(['verification_legacy_loop_enabled'])
      .then((value) => setLegacyEnabled(value.verification_legacy_loop_enabled === true))
      .catch(() => setLegacyEnabled(false));
  }, []);
  return legacyEnabled ? <LegacyLoopTestApp /> : <VerificationCycleController />;
}
