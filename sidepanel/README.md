# Voidr Loop Test — Side Panel

Sub-projeto Vite (Preact + TypeScript) do side panel de Loop Test da extensão.
O restante da extensão continua vanilla JS — **só** este diretório tem build.

O manifest carrega o output do build diretamente:

```json
"side_panel": { "default_path": "sidepanel/dist/index.html" }
```

## Build

```bash
cd sidepanel
npm install
npm run build     # gera sidepanel/dist/ (comitado junto — o manifest aponta pra ele)
```

Da raiz da extensão também funciona: `npm run sidepanel:build`.

Após o build, recarregue a extensão em `chrome://extensions`. Não há passo de
dev-server útil aqui: o painel depende das APIs `chrome.*` da extensão, então o
ciclo é build → reload.

Type-check isolado: `npm run check` (tsc `--noEmit`).

## O que tem aqui

- **UI do painel** (`src/app.tsx`): lista de loops, resumo do estado (ciclo
  oficial em processamento com stepper), preview da gravação baseline (deep-link
  para o replay na plataforma), hint do harness MCP (nunca terminal), e
  **Replay rápido** consultivo (secrets → passos → veredito local).
- **Entrada pela home**: o popup da extensão tem o botão **Loop Test** que abre
  este side panel a qualquer momento (não só após gravar).
- **Quick-runner** (`src/runner/`): interpreta o IR `VoidrJourney` direto
  (navigate/click/fill/select/check/expect-url) tentando os candidatos de
  seletor ranqueados em ordem — espelho do `resolveTarget` compilado.
  - `driver.ts` — interface do driver (troca de engine sem tocar no run loop).
  - `crx-driver.ts` — implementação com **playwright-crx 0.15.0 (pinado)**,
    que dirige a aba via `chrome.debugger`/CDP. Community-maintained: se
    apodrecer, o substituto implementa `QuickRunDriver` e nada mais muda.
  - `quick-run.ts` — engine: timeout de 10s/passo e 3min/run, Cancel,
    estado do run espelhado em `chrome.storage.session` (guarda de reattach
    para o padrão de suspensão do MV3), detach limpo em qualquer saída.
  - `locator-parser.ts` — parser estrutural das expressões de locator do IR
    (páginas MV3 não podem `eval`; a gramática emitida pelo compilador do
    hive é fechada e conhecida).

## Contratos consumidos (todos via proxy `apiRequest` do background, Auth0)

- `GET /loop-test/scenarios` — listagem (defensivo: sem endpoint → input manual)
- `GET /loop-test/scenarios/{id}` — card do cenário (defensivo)
- `GET /loop-test/scenarios/{id}/journey` — IR compilado+curado (existe após o
  primeiro run do hive)
- `POST /loop-test/scenarios/{id}/quick-runs` — registro do quick run no ledger
  (defensivo: falha só loga)

## Segurança

- Quick run **não grava sessão** (collector nunca é injetado) e não compara
  baseline — veredito é apenas verde/primeira-falha, consultivo.
- Segredos do IR (`params[]`) são pedidos no painel antes do run, vivem só na
  memória do documento do painel e nunca vão para storage, logs ou serviço.
