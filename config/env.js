/*
  Environment variables for the Voidr extension.

  COMO FUNCIONA:
  - Este arquivo é o ÚNICO consumido em runtime:
      * background/background.js  -> importScripts('config/env.js')
      * popup/popup.html          -> <script src="../config/env.js">
  - Ele define globalThis.__VOIDR_ENV__. O background faz merge com os
    DEFAULTS (produção): cada chave usada é `__VOIDR_ENV__.X || DEFAULT.X`.
    => O que você preencher aqui SOBRESCREVE; o que omitir cai no default de prod.
  - O arquivo `.env` na raiz NÃO é lido por nada; é só referência.

  CHAVES LIDAS PELO CÓDIGO (background.js:24-29):
    VOIDR_API_BASE_URL, VOIDR_PLATFORM_URL, VOIDR_COLLECTOR_URL,
    VOIDR_AUTH0_DOMAIN, VOIDR_AUTH0_CLIENT_ID, VOIDR_AUTH0_AUDIENCE
  (ENVIRONMENT é apenas rótulo — não é lido em lugar nenhum.)

  COMO TROCAR DE AMBIENTE:
    Descomente UM bloco de URLs abaixo (ou edite os valores ativos).
    As chaves de Auth0 são iguais em todos os ambientes hoje (tenant bounties4),
    então normalmente NÃO precisam ser preenchidas — deixe cair no default.

  Note: Do NOT commit secrets. This file is meant for local/dev packaging.
*/

(function initializeVoidrEnv() {
  var env = {
    ENVIRONMENT: 'production',

    // ---- URLs (descomente o bloco do ambiente desejado) --------------------

    // Produção (ATIVO)
    VOIDR_API_BASE_URL: 'https://api.voidr.co/v1',
    VOIDR_PLATFORM_URL: 'https://platform.voidr.co',
    VOIDR_COLLECTOR_URL: 'https://collector.voidr.co',

    // Preview (release-unified-hive-chat)
    // VOIDR_API_BASE_URL: 'https://release-unified-hive-chat.api-preview.voidr.co/v1',
    // VOIDR_PLATFORM_URL: 'https://release-unified-hive-chat.app-preview.voidr.co',
    // VOIDR_COLLECTOR_URL: 'https://collector-staging.voidr.co',

    // Staging
    // VOIDR_API_BASE_URL: 'https://api-staging.voidr.co/v1',
    // VOIDR_PLATFORM_URL: 'https://staging.voidr.co',
    // VOIDR_COLLECTOR_URL: 'https://collector-staging.voidr.co',

    // Local (dev)
    // VOIDR_API_BASE_URL: 'http://localhost:3000/v1',
    // VOIDR_PLATFORM_URL: 'http://localhost:3030',
    // VOIDR_COLLECTOR_URL: 'http://localhost:3333',

    // ---- Auth0 (opcional) --------------------------------------------------
    // Deixe comentado para usar o default de produção (tenant bounties4).
    // Só preencha se o ambiente usar um tenant/app Auth0 diferente.
    // VOIDR_AUTH0_DOMAIN: 'bounties4.us.auth0.com',
    // VOIDR_AUTH0_CLIENT_ID: 'c4eLr6uaq98KB2dCKNkmP9bz6sS3gJfS',
    // VOIDR_AUTH0_AUDIENCE: 'https://service.bounties4.com/',
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__VOIDR_ENV__ = env;
  } else if (typeof window !== 'undefined') {
    window.__VOIDR_ENV__ = env;
  } else if (typeof self !== 'undefined') {
    self.__VOIDR_ENV__ = env;
  }
})();
