(function exposeVerificationHandoffUx(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VoidrVerificationHandoffUx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createApi() {
  const STEPS = [
    { id: 'requests', label: 'Consolidando requisições' },
    { id: 'actions', label: 'Consolidando cliques' },
    { id: 'evidence', label: 'Organizando snapshots e anotações' },
    { id: 'handoff', label: 'Preparando contexto para o harness' },
  ];

  const STATE_PROGRESS = {
    stopping: 0,
    sealing: 1,
    context: 2,
    available: 4,
    acknowledged: 4,
    product_ready: 4,
    pending: 3,
    failed: 0,
  };

  function safeHarness(input) {
    const connected = Boolean(input && typeof input === 'object');
    const name =
      connected && typeof input?.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim().slice(0, 80)
        : '';
    return {
      name,
      provider: connected && typeof input?.provider === 'string' ? input.provider : null,
      connected,
    };
  }

  function viewModel(state, harnessInput, options = {}) {
    const harness = safeHarness(harnessInput);
    const progress = STATE_PROGRESS[state] ?? 0;
    const steps = STEPS.map((step, index) => ({
      ...step,
      label:
        step.id === 'handoff'
          ? harness.connected
            ? `Contexto para ${harness.name}`
            : 'Publicando ciclo na Voidr'
          : step.label,
      state: index < progress ? 'done' : index === progress ? 'active' : 'pending',
    }));

    if (state === 'acknowledged') {
      return {
        tone: 'success',
        eyebrow: `Ciclo #${options.cycleNumber ?? 1}`,
        title: `Recebido pelo ${harness.name}`,
        detail:
          'O contexto compacto e suas evidências já chegaram ao agente. Ele vai explicar o diagnóstico antes de pedir permissão para corrigir.',
        harness,
        steps: steps.map((step) => ({ ...step, state: 'done' })),
        terminal: true,
        truthfulReceipt: true,
      };
    }
    if (state === 'available') {
      return {
        tone: 'ready',
        eyebrow: `Ciclo #${options.cycleNumber ?? 1}`,
        title: `Contexto disponível para ${harness.name}`,
        detail:
          'A gravação está segura. O harness conectado pode consumir o resumo citado sem carregar o replay bruto.',
        harness,
        steps: steps.map((step) => ({ ...step, state: 'done' })),
        terminal: true,
        truthfulReceipt: false,
      };
    }
    if (state === 'product_ready') {
      return {
        tone: 'success',
        eyebrow: `Ciclo #${options.cycleNumber ?? 1}`,
        title: 'Ciclo pronto para revisar',
        detail:
          'A gravação, as evidências e o transcript estão disponíveis na página interna do Loop.',
        harness,
        steps: steps.map((step) => ({ ...step, state: 'done' })),
        terminal: true,
        truthfulReceipt: true,
      };
    }
    if (state === 'pending') {
      return {
        tone: 'pending',
        eyebrow: `Ciclo #${options.cycleNumber ?? 1}`,
        title: 'Ciclo preservado',
        detail:
          'O seal foi confirmado. A indexação continua em segundo plano e o contexto será disponibilizado assim que estiver consistente.',
        harness,
        steps,
        terminal: true,
        truthfulReceipt: false,
      };
    }
    if (state === 'failed') {
      return {
        tone: 'danger',
        eyebrow: 'A gravação continua preservada',
        title: 'Não foi possível concluir agora',
        detail:
          typeof options.error === 'string' && options.error.trim()
            ? options.error.trim().slice(0, 180)
            : 'Tente novamente. Nenhum dado confirmado será descartado.',
        harness,
        steps,
        terminal: true,
        retryable: true,
        truthfulReceipt: false,
      };
    }

    const copy = {
      stopping: {
        title: 'Consolidando sua gravação',
        detail: 'Fechando o fluxo sem perder os últimos eventos.',
      },
      sealing: {
        title: 'Confirmando evidências',
        detail: 'Validando o watermark durável do collector.',
      },
      context: {
        title: harness.connected
          ? `Preparando contexto para ${harness.name}`
          : 'Preparando o ciclo para revisão',
        detail: 'Extraindo apenas os sinais úteis, com referências para cada conclusão.',
      },
    }[state] ?? {
      title: 'Processando ciclo',
      detail: 'Mantendo a gravação e as evidências consistentes.',
    };
    return {
      tone: 'working',
      eyebrow: `Ciclo #${options.cycleNumber ?? 1}`,
      ...copy,
      harness,
      steps,
      terminal: false,
      truthfulReceipt: false,
    };
  }

  function stateFromDelivery(delivery) {
    if (delivery?.state === 'acknowledged') return 'acknowledged';
    if (delivery?.state === 'available') return 'available';
    if (delivery?.state === 'failed') return 'failed';
    return 'pending';
  }

  return { viewModel, stateFromDelivery, safeHarness };
});
