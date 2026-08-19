#!/usr/bin/env node
// Guardas de compliance e de carregabilidade do pacote da Chrome Web Store.
// Roda antes do zip: falhar aqui é melhor que falhar em silêncio no navegador.
import { readFileSync } from 'node:fs';

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const recorder = readFileSync('vendor/recorder.min.js', 'utf8');
const sources = ['background/background.js', 'popup/popup.js', 'config/env.js']
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

// O Chrome recusa carregar arquivo com noncharacter/surrogate via
// executeScript({files}) — "It isn't UTF-8 encoded" — e a falha é silenciosa.
const bad = [...recorder].filter((c) => {
  const o = c.codePointAt(0);
  return (o & 0xffff) === 0xfffe || (o & 0xffff) === 0xffff
    || (o >= 0xd800 && o <= 0xdfff) || (o >= 0xfdd0 && o <= 0xfdef);
});
check(bad.length === 0, `vendor/recorder.min.js tem ${bad.length} noncharacter(s) — Chrome nao carrega. Rebuild com esbuild charset:'ascii'.`);
check(recorder.includes('window.VoidrCollector='), 'vendor/recorder.min.js nao expoe window.VoidrCollector');

// Politica de codigo remoto: nada pode ser baixado e executado.
check(!sources.includes('fetchCollectorCode'), 'fetchCollectorCode presente — codigo remoto');
check(!sources.includes('(0, eval)'), 'eval() presente — codigo remoto');
check(!sources.includes('fonts.googleapis'), 'Google Fonts presente — recurso remoto');

// Politica de permissao minima: nada de acesso amplo concedido na instalacao.
// O acesso ao site alvo e pedido em runtime, no clique de "Concordo e iniciar".
const broad = /^(https?:\/\/\*\/\*|<all_urls>)$/;
check((manifest.host_permissions || []).every((h) => !broad.test(h)),
  `host_permissions amplo na instalacao: ${JSON.stringify(manifest.host_permissions)} — deve ficar em optional_host_permissions`);
check((manifest.optional_host_permissions || []).length > 0,
  'optional_host_permissions ausente — o acesso ao site alvo precisa ser pedido em runtime');
check(manifest.content_scripts.every((cs) => cs.matches.every((m) => !broad.test(m))),
  'content_script com <all_urls> — dispara o mesmo aviso de "todos os sites" que host_permissions');

// Permissao redundante e motivo declarado de rejeicao. Checa o array parseado:
// background.js tem uma variavel local chamada activeTab e grep da falso positivo.
check(!manifest.permissions.includes('activeTab'), 'activeTab de volta no manifest');

// URLs internas nao podem viajar num pacote publico.
check(!/run\.app|preview\.voidr\.co/.test(sources), 'URL interna (Cloud Run / preview) no pacote');

if (fails.length) {
  console.error('verify-package FALHOU:');
  for (const f of fails) console.error('  x ' + f);
  process.exit(1);
}
console.log(`verify-package OK — manifest v${manifest.version}, recorder ${recorder.length} chars, 0 nao-ASCII`);
