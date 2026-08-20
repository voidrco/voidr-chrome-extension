/**
 * Human-readable Loop Test status vocabulary (PT-BR).
 * Mirrors voidr-platform/src/pages/loops/loopMeta.ts — kept local so the
 * sidepanel does not depend on the platform package.
 */

export const STATUS_LABEL: Record<string, string> = {
  recording: 'Aguardando gravação',
  ingesting: 'Processando gravação',
  compiling: 'Compilando roteiro',
  replaying: 'Em processamento',
  comparing: 'Em processamento',
  healing: 'Em processamento',
  fix_required: 'Precisa da sua correção',
  green: 'Verde',
  failed: 'Falhou',
};

export const STATUS_TONE: Record<string, 'cyan' | 'green' | 'red' | 'dim'> = {
  recording: 'cyan',
  ingesting: 'cyan',
  compiling: 'cyan',
  replaying: 'cyan',
  comparing: 'cyan',
  healing: 'cyan',
  fix_required: 'red',
  green: 'green',
  failed: 'dim',
};

/** Stages shown while the authoritative cycle is in flight. */
export const CYCLE_STAGES = [
  { key: 'ingesting', label: 'Preparação' },
  { key: 'compiling', label: 'Compilação' },
  { key: 'replaying', label: 'Execução' },
  { key: 'comparing', label: 'Comparação' },
  { key: 'healing', label: 'Cura' },
] as const;

const IN_FLIGHT = new Set(['ingesting', 'compiling', 'replaying', 'comparing', 'healing']);

export function isInFlight(status?: string): boolean {
  return !!status && IN_FLIGHT.has(status);
}

export function statusLabel(status?: string): string {
  if (!status) return '—';
  return STATUS_LABEL[status] ?? status;
}

export function statusTone(status?: string): 'cyan' | 'green' | 'red' | 'dim' {
  if (!status) return 'dim';
  return STATUS_TONE[status] ?? 'dim';
}

/** One-line summary of what the loop is doing right now. */
export function statusSummary(status?: string, cycle?: number): string {
  const n = typeof cycle === 'number' && cycle > 0 ? ` · ciclo ${cycle}` : '';
  switch (status) {
    case 'recording':
      return 'Aguardando a gravação do fluxo no browser.';
    case 'compiling':
      return `O harness está transformando a gravação em jornada executável${n}.`;
    case 'ingesting':
      return `Preparando a sessão e aguardando todos os chunks da gravação${n}.`;
    case 'replaying':
      return `O ciclo oficial está reexecutando o fluxo gravado${n}.`;
    case 'comparing':
      return `Comparando o resultado com o baseline (DOM + visual)${n}.`;
    case 'healing':
      return `Ajustando seletores que mudaram e revalidando${n}.`;
    case 'fix_required':
      return 'Algo quebrou de verdade — o agente no harness precisa corrigir.';
    case 'green':
      return 'Último ciclo passou. O loop está saudável.';
    case 'failed':
      return 'O ciclo falhou por infraestrutura. Dispare novamente pelo harness.';
    default:
      return 'Acompanhe o estado do loop aqui ou na plataforma.';
  }
}

export function stageIndex(status?: string): number {
  if (!status) return -1;
  const i = CYCLE_STAGES.findIndex((s) => s.key === status);
  if (i >= 0) return i;
  if (status === 'green') return CYCLE_STAGES.length;
  if (status === 'fix_required' || status === 'failed') return CYCLE_STAGES.length - 1;
  return -1;
}
