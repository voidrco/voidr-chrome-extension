# Build da Chrome Web Store

Este repo é a **fonte de verdade do que vai publicado na Chrome Web Store**.
Ele não substitui [`voidr-chrome-extension`](https://github.com/voidrco/voidr-chrome-extension),
que continua sendo o repo de desenvolvimento e do build interno (unpacked).

|           |                                                |
| --------- | ---------------------------------------------- |
| Item      | Voidr Testing Assistant                        |
| ID        | `fdkbhgmcalkifcajaggkifcfoegaocpl`             |
| Publisher | Voidr — `de27263a-f10e-4aa2-8e65-4f2f0f5eb22d` |
| Baseline  | pacote enviado como rascunho em 2026-08-04     |

## Por que existe

O build da store diverge do repo de desenvolvimento em pontos que **não podem regredir**,
sob pena de rejeição na análise do Google. Antes deste repo essa divergência vivia como
working tree não commitada numa pasta local — qualquer rebuild a partir do `main` a apagava.

## As 5 divergências (não reverter sem ler)

### 1. Collector empacotado, nunca baixado — **crítico**

O repo de desenvolvimento baixa `https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js`
e roda com `eval()`. **Aqui isso é proibido**: a política de código remoto da Chrome Web Store
veta executar JS que não esteja dentro do pacote.

Aqui o collector é o arquivo `vendor/recorder.min.js`, injetado por
`chrome.scripting.executeScript({ files: [...] })`.

É isso que sustenta o **"Não estou usando código remoto"** já declarado no formulário de
privacidade do item. Reverter para o `eval()` do CDN = declaração falsa = rejeição.

### 2. `activeTab` fora do manifest

`host_permissions` (`http://*/*`, `https://*/*`) já cobre tudo que a extensão faz.
Permissão redundante é motivo declarado de rejeição pelo próprio console.

Nota: `chrome.tabs.captureVisibleTab` (case `captureScreenshot` em `background/background.js`)
é a única API que exigiria `activeTab` — e hoje **não tem chamador nenhum no pacote**.
Se alguém religar esse caminho, reavaliar: a permissão de host cobre páginas http/https,
mas não `chrome://`, `file://` nem a própria Web Store.

### 3. Aviso de consentimento no popup

As telas de início de gravação mostram o que é capturado + link para a Política de
Privacidade, e o botão é **"Concordo e iniciar"**, não "Iniciar gravação".
A análise avalia consentimento explícito antes da captura.

### 4. Sem Google Fonts

`popup.html` não carrega Space Grotesk de `fonts.googleapis.com`; a fonte cai para o
stack do sistema. Recurso remoto no pacote é problema de compliance.
É regressão visual de marca aceita conscientemente.

### 5. `extension:build` com allowlist explícita

O script zipa uma lista fixa de pastas em vez de `.` com exclusões.
**Pegadinha:** pasta nova (`lib/`, `utils/`) fica fora do zip sem erro nenhum.
Ao adicionar diretório, editar o script.

## Atualizar o collector

O `vendor/recorder.min.js` é um snapshot. Ele **não se atualiza sozinho** — esse é o preço
da divergência nº 1, e não tem como fugir dele.

```
cd vendor
curl -o recorder.min.js "https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js"
shasum -a256 recorder.min.js     # registrar o hash no commit
```

Depois: bump de `version` no `manifest.json`, rebuild, submeter. O Chrome distribui a versão
nova sozinho para os usuários instalados assim que o Google aprovar — ninguém reinstala nada.

Para ajuste de comportamento que não pode esperar review, a saída legítima é o collector ler
**configuração** remota (dado, permitido), nunca código novo.

## Trazer mudança do repo de desenvolvimento

```
git remote add dev git@github.com:voidrco/voidr-chrome-extension.git
git fetch dev
git diff HEAD dev/main -- <caminho>     # revisar SEMPRE antes
```

Nunca fazer merge cego de `dev/main`: ele traz de volta `fetchCollectorCode()`, o `eval()`
e o `activeTab`. Portar arquivo a arquivo.

## Checklist antes de submeter

- [ ] `vendor/recorder.min.js` é o snapshot pretendido (hash conferido)
- [ ] `config/env.js` aponta para produção, sem bloco de staging/local descomentado
- [ ] `manifest.json` sem `activeTab`; `version` bumpada
      (checar o array `permissions` parseado, **nunca** `grep activeTab` — o
      `background.js` tem uma variável local com esse nome e o grep dá 9 falsos positivos)
- [ ] `background/background.js` sem `fetchCollectorCode` / `eval`
- [ ] nenhuma URL interna no pacote (`grep -rn "run.app\|preview.voidr.co"`)
- [ ] `npm run extension:build` e conferir `unzip -l dist/voidr-extension.zip`
- [ ] smoke unpacked: gravar uma sessão ponta a ponta e confirmar que o collector injetou
- [ ] **Instruções de teste** preenchidas no console (conta de review + passo do código VDR)

## Publicacao automatica

PRs que alteram arquivos do pacote precisam aumentar `version` em `manifest.json` e
`package.json`. O check `Extension release guard` compara a versao da PR com a `main` e
deve ser obrigatorio na protecao da branch.

Depois do merge, `.github/workflows/extension-publish.yml` gera o ZIP, envia a nova
versao para revisao e pede publicacao automatica quando o Google aprovar. Mudancas apenas
em documentacao, testes ou CI nao geram uma nova submissao.

O repositorio precisa destas variaveis em **Settings > Secrets and variables > Actions**:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: provider que aceita tokens somente deste repo e da `main`.
- `GCP_CHROME_WEBSTORE_SERVICE_ACCOUNT`: e-mail da conta de servico adicionada ao publisher.
- `CHROME_WEBSTORE_PUBLISHER_ID`: `de27263a-f10e-4aa2-8e65-4f2f0f5eb22d`.

A Chrome Web Store API precisa estar habilitada no projeto Google Cloud. A conta de servico
tambem precisa ser adicionada em **Chrome Web Store Developer Dashboard > Account**.
