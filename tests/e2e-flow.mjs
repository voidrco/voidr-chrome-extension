// E2E do fluxo real: Assistant -> codigo VDR -> extensao -> gravar -> parar.
// Roda com a extensao carregada num perfil persistente (o login sobrevive entre
// execucoes). Existe porque testar o mecanismo isolado nao pegou nenhum dos tres
// bugs de 2026-08-18 — todos moravam no fluxo, nao na peca.
//
//   npm run e2e            fluxo completo
//   npm run e2e -- --login so abre o navegador para login manual e sai
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PERFIL = path.join(RAIZ, '.e2e-profile');
const PLATAFORMA = 'https://platform.voidr.co';
const SO_LOGIN = process.argv.includes('--login');

const log = (fase, msg) => console.log(`[${fase}] ${msg}`);
const falha = (msg) => { console.error(`\n❌ ${msg}\n`); process.exitCode = 1; };

fs.mkdirSync(PERFIL, { recursive: true });

const ctx = await chromium.launchPersistentContext(PERFIL, {
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${RAIZ}`, `--load-extension=${RAIZ}`],
});

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
const EXT_ID = new URL(sw.url()).host;
log('setup', `extensao ${EXT_ID}`);

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(PLATAFORMA, { waitUntil: 'domcontentloaded' });

// ── login (manual, uma vez — o perfil persiste) ─────────────────────────────
const logado = async () =>
  page.locator('text=/Assistant|Conversations|What would you like to do/i').first()
    .isVisible({ timeout: 5000 }).catch(() => false);

if (!(await logado())) {
  log('login', 'nao autenticado — faca login nesta janela. Aguardando ate 5 min...');
  try {
    await page.locator('text=/Assistant|Conversations|What would you like to do/i').first()
      .waitFor({ state: 'visible', timeout: 300000 });
    log('login', 'autenticado — perfil salvo, proximas rodadas nao pedem de novo');
  } catch {
    falha('login nao concluido em 5 min');
    await ctx.close();
    process.exit(1);
  }
} else {
  log('login', 'ja autenticado (perfil persistente)');
}

if (SO_LOGIN) {
  log('login', 'modo --login: encerrando');
  await ctx.close();
  process.exit(0);
}

// ── Assistant -> codigo VDR ─────────────────────────────────────────────────
try {
  log('assistant', 'enviando prompt');
  const campo = page.getByPlaceholder(/Ask about quality|Pergunte sobre/i).first();
  await campo.waitFor({ timeout: 20000 });
  await campo.fill('i want to generate tests');
  await campo.press('Enter');

  log('assistant', 'aguardando opcoes');
  await page.getByText(/Create new tests/i).first().click({ timeout: 90000 });

  log('assistant', 'escolhendo aplicacao');
  await page.getByText(/Teste Application/i).first().click({ timeout: 90000 });

  log('assistant', 'continuando para sessoes');
  await page.getByText(/Continuar para sess/i).first().click({ timeout: 90000 });

  log('assistant', 'lendo codigo VDR');
  const codigoEl = page.locator('text=/^VDR-[A-Z0-9]+$/').first();
  await codigoEl.waitFor({ timeout: 90000 });
  const codigo = (await codigoEl.innerText()).trim();
  log('assistant', `codigo ${codigo}`);

  // ── abre o alvo ───────────────────────────────────────────────────────────
  log('alvo', 'clicando em Abrir aplicacao');
  const [abaAlvo] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 30000 }),
    page.getByText(/Abrir aplica|Reabrir aplica/i).first().click(),
  ]);
  await abaAlvo.waitForLoadState('domcontentloaded');
  log('alvo', abaAlvo.url().slice(0, 80));

  // ── popup da extensao ─────────────────────────────────────────────────────
  // O background abre a UI sozinho via auto-connect; se nao abrir em 10s,
  // abrimos manualmente, que e o caminho do usuario que clica no icone.
  log('extensao', 'procurando a UI da extensao');
  let ui = ctx.pages().find((p) => p.url().startsWith(`chrome-extension://${EXT_ID}`));
  if (!ui) {
    ui = await ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    if (ui && !ui.url().startsWith(`chrome-extension://${EXT_ID}`)) ui = null;
  }
  if (!ui) {
    log('extensao', 'nao abriu sozinha — abrindo popup manualmente');
    ui = await ctx.newPage();
    await ui.goto(`chrome-extension://${EXT_ID}/popup/popup.html`);
  }
  await ui.bringToFront();

  const conectar = ui.getByText(/Conectar com Voidr/i).first();
  if (await conectar.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('extensao', 'clicando em Conectar com Voidr');
    await conectar.click();
    await ui.waitForTimeout(3000);
  }

  const campoCodigo = ui.getByPlaceholder(/VDR-|onboarding/i).first();
  if (await campoCodigo.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('extensao', 'colando o codigo');
    await campoCodigo.fill(codigo);
    await ui.getByRole('button', { name: /Conectar/i }).first().click();
  }

  // ── consentimento + gravacao ──────────────────────────────────────────────
  log('gravacao', 'clicando em Concordo e iniciar');
  await ui.getByText(/Concordo e iniciar/i).first().click({ timeout: 30000 });

  await abaAlvo.bringToFront();
  const barra = abaAlvo.locator('text=/Gravando sess/i').first();
  await barra.waitFor({ timeout: 30000 });
  log('gravacao', 'barra de gravacao visivel ✓');

  const injetado = await abaAlvo.evaluate(() => typeof window.VoidrCollector);
  log('gravacao', `window.VoidrCollector = ${injetado}`);
  if (injetado !== 'object') falha('collector nao injetou no world MAIN');

  log('gravacao', 'interagindo com o site');
  for (const _ of [1, 2, 3]) {
    await abaAlvo.mouse.wheel(0, 400);
    await abaAlvo.waitForTimeout(800);
  }

  log('gravacao', 'clicando em Parar');
  await abaAlvo.getByText(/^Parar$/i).first().click({ timeout: 15000 });

  // ── veredito ──────────────────────────────────────────────────────────────
  const falhou = abaAlvo.locator('text=/Nao foi possivel confirmar|não foi possível confirmar/i').first();
  const ok = abaAlvo.locator('text=/Sess[ãa]o enviada|capturada|conclu/i').first();
  const venceu = await Promise.race([
    falhou.waitFor({ timeout: 60000 }).then(() => 'FALHOU'),
    ok.waitFor({ timeout: 60000 }).then(() => 'OK'),
  ]).catch(() => 'SEM BANNER');

  if (venceu === 'OK') log('veredito', '✅ sessao aceita');
  else falha(`gravacao terminou em: ${venceu}`);
} catch (e) {
  falha(`quebrou: ${e?.message || e}`);
  const shot = path.join(RAIZ, 'dist', 'e2e-falha.png');
  await ctx.pages().at(-1)?.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.error(`screenshot: ${shot}`);
}

await ctx.close();
