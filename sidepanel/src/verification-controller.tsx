import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  ApiError,
  getPlatformBaseUrl,
  getVerificationStatus,
  handoffVerification,
  listVerifications,
  prepareVerification,
} from './api';
import type { VerificationPhase, VerificationStatusView, VerificationSummary } from './types';

const LABELS: Record<string, string> = {
  prepared: 'Preparar',
  recording: 'Gravar',
  sealing: 'Selar',
  artifact_ready: 'Artifact',
  diagnosing: 'Diagnosticar',
  decision_required: 'Decidir',
};

function runtimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        reject(
          new Error(
            response?.error ||
              chrome.runtime.lastError?.message ||
              'A extensão não confirmou a operação.',
          ),
        );
        return;
      }
      resolve(response as T);
    });
  });
}

function VerificationPhases({ phases }: { phases: VerificationPhase[] }) {
  return (
    <ol class="verification-phases" aria-label="Progresso da Verification">
      {phases.map((phase) => (
        <li class={`verification-phase ${phase.state}`} key={phase.id}>
          <span class="verification-phase-dot" aria-hidden="true">
            {phase.state === 'completed' ? '✓' : phase.state === 'failed' ? '!' : ''}
          </span>
          <span>{LABELS[phase.id] ?? phase.id}</span>
        </li>
      ))}
    </ol>
  );
}

function statusCopy(status: VerificationStatusView) {
  if (status.status === 'recording') {
    return 'Execute a missão na aba alvo. Você pode anotar um elemento ou uma região.';
  }
  if (status.status === 'sealing') return 'Drenando chunks e aguardando o seal autoritativo.';
  if (status.status === 'artifact_ready') return 'O artifact VAP está pronto para diagnóstico.';
  if (status.status === 'diagnosing') return 'Produzindo claims limitadas e citadas.';
  if (status.status === 'decision_required') return 'Diagnóstico pronto para decisão humana.';
  if (status.status === 'confirmed') return 'Verification confirmada por uma pessoa.';
  if (status.status === 'open') return 'Verification mantida aberta.';
  if (status.status === 'failed') return 'A fase atual falhou sem fabricar uma conclusão.';
  return 'Pronta para handoff seguro à extensão.';
}

export function VerificationCycleController() {
  const [items, setItems] = useState<VerificationSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState<VerificationStatusView | null>(null);
  const [mission, setMission] = useState('Reproduzir a falha e anotar o comportamento observado.');
  const [targetUrl, setTargetUrl] = useState('http://localhost:3030/checkout-retry');
  const [platformBase, setPlatformBase] = useState('http://localhost:3030');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);

  const refreshList = useCallback(async () => {
    try {
      const next = await listVerifications();
      setItems(next);
      if (!selectedId && next[0]) setSelectedId(next[0].verificationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selectedId]);

  useEffect(() => {
    void getPlatformBaseUrl().then(setPlatformBase);
    void refreshList();
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setStatus(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const next = await getVerificationStatus(selectedId);
        if (alive) {
          setStatus(next);
          setError(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareVerification({
        mission,
        targetUrl,
        environment: 'local',
      });
      setItems((current) => [prepared, ...current]);
      setSelectedId(prepared.verificationId);
      setStatus(prepared);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [mission, targetUrl]);

  const start = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setError(null);
    try {
      const handoff = await handoffVerification(status);
      if (!handoff.capability?.token) {
        throw new ApiError('O handoff duplicado não devolveu uma capability recuperável.');
      }
      await runtimeMessage({
        action: 'voidr:startVerification',
        verification: handoff.verification,
        capability: handoff.capability,
      });
      setStatus(handoff.verification);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [status]);

  const reportUrl = useMemo(
    () =>
      status
        ? `${platformBase}/loops/verifications/${encodeURIComponent(status.verificationId)}`
        : `${platformBase}/loops/verifications`,
    [platformBase, status],
  );

  return (
    <main class="panel verification-controller">
      <header class="header">
        <img class="header-logo" src={chrome.runtime.getURL('assets/logo-light.svg')} alt="Voidr" />
        <div class="header-text">
          <span class="header-title">Verification</span>
          <span class="header-sub">Missão manual · HIL/1 · VAP/1</span>
        </div>
        <span class="verification-live">LOCAL</span>
      </header>

      {offline ? (
        <div class="state-box warning" role="status">
          Offline — a gravação permanece local e o envio será retomado quando a rede voltar.
        </div>
      ) : null}
      {error ? (
        <div class="error-box" role="alert">
          {error}
        </div>
      ) : null}

      <section class="card verification-create" aria-labelledby="new-verification">
        <div class="section-label" id="new-verification">
          Nova missão
        </div>
        <label>
          <span>Missão manual</span>
          <textarea value={mission} onInput={(event) => setMission(event.currentTarget.value)} />
        </label>
        <label>
          <span>URL alvo</span>
          <input
            type="url"
            value={targetUrl}
            onInput={(event) => setTargetUrl(event.currentTarget.value)}
          />
        </label>
        <button
          class="btn btn-primary"
          disabled={busy || !mission.trim() || !targetUrl.trim() || offline}
          onClick={create}
        >
          Preparar Verification
        </button>
      </section>

      <section aria-labelledby="active-verification">
        <div class="section-label" id="active-verification">
          Ciclo ativo
        </div>
        <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
          <option value="">Selecione uma Verification…</option>
          {items.map((item) => (
            <option value={item.verificationId} key={item.verificationId}>
              #{item.cycleNumber} · {item.mission.slice(0, 44)}
            </option>
          ))}
        </select>
      </section>

      {status ? (
        <section class="card verification-progress" aria-live="polite">
          <div class="verification-progress-head">
            <div>
              <span class="verification-eyebrow">Ciclo {status.cycleNumber}</span>
              <h1>{status.mission}</h1>
            </div>
            <span class={`status-badge ${status.status}`}>
              {status.status.replaceAll('_', ' ')}
            </span>
          </div>
          <p>{statusCopy(status)}</p>
          <VerificationPhases phases={status.phases} />
          <div class="verification-meta">
            <span>version {status.lifecycleVersion}</span>
            <span>binding {status.bindingId.slice(0, 8)}</span>
            {status.billing ? (
              <span>
                {status.billing.status === 'disabled'
                  ? 'local · sem cobrança'
                  : `${status.billing.credits} crédito · ${status.billing.status === 'settled' ? 'liquidado' : 'reserva'}`}
              </span>
            ) : null}
          </div>
          {status.status === 'prepared' ? (
            <button class="btn btn-primary" disabled={busy || offline} onClick={start}>
              {busy ? <span class="spinner" /> : '●'} Iniciar gravação manual
            </button>
          ) : null}
          {status.artifactReady ? (
            <button class="btn btn-primary" onClick={() => chrome.tabs.create({ url: reportUrl })}>
              Abrir Evidence Room →
            </button>
          ) : null}
        </section>
      ) : (
        <div class="empty-card">
          <div class="empty-title">Nenhuma Verification selecionada</div>
          <p class="muted">Prepare uma missão para iniciar o fluxo manual.</p>
        </div>
      )}

      <footer class="verification-footer">
        OAuth, vídeo e deliveries externos podem usar adapters locais. O consumo do ciclo é
        autoritativo e idempotente.
      </footer>
    </main>
  );
}
