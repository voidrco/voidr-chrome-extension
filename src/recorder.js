import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { gzip } from 'pako';

const VOIDR_VERSION = '1.8.2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Função para detectar ambientes de automação
function isAutomationEnvironment() {
  try {
    // Detecção de webdriver (Playwright, Selenium, Puppeteer)
    if (navigator.webdriver === true) {
      return true;
    }

    // Detecção específica do Playwright
    if (window.playwright !== undefined) {
      return true;
    }

    // Detecção de PhantomJS
    if (window.callPhantom || window._phantom) {
      return true;
    }

    // Detecção adicional via propriedades do Chrome DevTools Protocol
    if (window.__playwright || window.__puppeteer) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Função para serialização segura (evita referências circulares)
function safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

const VoidrCollector = (function () {
  // ======= Configurações Internas =======
  let config = {
    apiKey: null,
    applicationId: null,
    environment: null,
    collectorUrl: __VOIDR_COLLECTOR_URL__,
    sessionTimeout: 30, // minutos
    system: false,
    skipRecording: false,
    samplingRate: 0.1, // 0 a 1 (0% a 100%), padrão 10%
    dataMasking: {
      text: false,
      inputs: false,
      blockSelectors: ['[data-sensitivity="block"]'],
    },
    networkCapture: true,
    captureConsole: true,
    user: null,
    meta: null,
  };

  let events = [];
  let networkBuffer = [];
  let sessionStartedAt = null;
  let userId = null;
  let sessionId = null;
  let stopRecording = null;
  let isSending = false;
  let observer = null;
  let authToken = null;
  let lastHref = null;
  let forceStop = false;
  let eventsInterval = null;
  let originalFetch = null;
  let originalXHR = null;
  let isInitialized = false;

  // HOTFIX: TASY-specific selector masking (remove after proper selector-based solution is deployed)
  const isTasy = typeof window !== 'undefined' && window.location.hostname.includes('tasy');
  const TASY_MASK_SELECTORS = [
    '.grid-canvas-right',
    '.person-bar-field-info',
    '.person-info',
    '#datagrid'
  ];

  // ======= Funções Auxiliares =======
  function generateSelector(el, maxDepth = 6) {
    if (!el || maxDepth === 0) return '';
    const parts = [];
    let current = el;

    for (let i = 0; i < maxDepth && current && current.nodeType === 1; i++) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      } else {
        const siblings = Array.from(current.parentNode ? current.parentNode.children : []);
        const sameTag = siblings.filter((s) => s.tagName === current.tagName);

        if (sameTag.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-child(${index})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function shouldIgnore(el) {
    if (!el.closest) return false;

    // Verificar seletor global + seletores customizados
    const selectors = [
      '[data-sensitivity="block"]',
      ...(config.dataMasking.blockSelectors || []),
    ].join(',');

    return el.closest(selectors);
  }

  function getTextContent(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  function throttle(fn, delay) {
    let lastCall = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        fn.apply(this, args);
        lastCall = now;
      }
    };
  }

  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function truncate(text, maxLength) {
    if (typeof text !== 'string') return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  }

  // ======= Base64 Image Compression =======
  const BASE64_DATA_URL_REGEX =
    /^data:image\/[^;]+;base64,[A-Za-z0-9+/=]{1000,}/;
  const MIN_BASE64_LENGTH = 100_000;

  function compressBase64Image(dataUrl, quality = 0.4, maxDim = 480) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(
              1,
              maxDim / Math.max(img.width, img.height),
            );
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const compressed = canvas.toDataURL('image/webp', quality);
            resolve(compressed.length < dataUrl.length ? compressed : dataUrl);
          } catch {
            resolve(dataUrl);
          }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
      } catch {
        resolve(dataUrl);
      }
    });
  }

  async function compressBase64InValue(value) {
    if (typeof value === 'string') {
      if (
        value.length >= MIN_BASE64_LENGTH &&
        BASE64_DATA_URL_REGEX.test(value)
      ) {
        return compressBase64Image(value);
      }
      return value;
    }

    if (Array.isArray(value)) {
      let changed = false;
      const result = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        result[i] = await compressBase64InValue(value[i]);
        if (result[i] !== value[i]) changed = true;
      }
      return changed ? result : value;
    }

    if (value && typeof value === 'object') {
      let changed = false;
      const result = {};
      for (const key of Object.keys(value)) {
        result[key] = await compressBase64InValue(value[key]);
        if (result[key] !== value[key]) changed = true;
      }
      return changed ? result : value;
    }

    return value;
  }

  async function compressEventsBase64(eventsBatch) {
    return Promise.all(eventsBatch.map((e) => compressBase64InValue(e)));
  }

  function isThirdParty(url) {
    try {
      const currentHost = window.location.hostname;
      const targetHost = new URL(url).hostname;
      return !targetHost.endsWith(currentHost);
    } catch (e) {
      return false;
    }
  }

  // ======= Network Capture Helpers =======
  const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB
  const SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-access-token',
    'api-key',
    'apikey',
    'password',
    'secret',
    'token',
    'credentials',
  ];

  // Content types que devemos capturar (comunicação de dados, não arquivos)
  const CAPTURABLE_CONTENT_TYPES = [
    'application/json',
    'application/xml',
    'text/xml',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
    'application/graphql',
    'application/graphql+json',
  ];

  // Content types que devemos ignorar (arquivos, HTML, binários)
  const IGNORED_CONTENT_TYPES = [
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'image/',
    'audio/',
    'video/',
    'font/',
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'application/gzip',
  ];

  /**
   * Verifica se o content-type é capturável (dados de API, não arquivos)
   */
  function isCapturableContentType(contentType) {
    if (!contentType) return false;
    const lowerType = contentType.toLowerCase();
    const isIgnored = IGNORED_CONTENT_TYPES.some((ignored) => lowerType.includes(ignored));
    if (isIgnored) return false;
    return CAPTURABLE_CONTENT_TYPES.some((allowed) => lowerType.includes(allowed));
  }

  /**
   * Redacta headers sensíveis para privacidade
   */
  function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    const sanitized = {};
    Object.entries(headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_HEADERS.some(
        (sensitive) => lowerKey.includes(sensitive) || lowerKey === sensitive,
      );
      sanitized[key] = isSensitive ? '[REDACTED]' : value;
    });
    return sanitized;
  }

  /**
   * Extrai headers de um objeto Headers (Fetch API)
   */
  function extractFetchHeaders(headers) {
    if (!headers) return {};
    const result = {};
    try {
      if (typeof headers.entries === 'function') {
        for (const [key, value] of headers.entries()) {
          result[key] = value;
        }
      } else if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          result[key] = value;
        });
      } else if (typeof headers === 'object') {
        Object.assign(result, headers);
      }
    } catch (e) {
      // Headers podem não ser acessíveis (CORS)
    }
    return result;
  }

  /**
   * Extrai headers de RequestInit ou Request object
   */
  function extractRequestHeaders(input, init) {
    const headers = {};
    try {
      // Se input é um Request object
      if (input instanceof Request) {
        const reqHeaders = extractFetchHeaders(input.headers);
        Object.assign(headers, reqHeaders);
      }
      // Headers do init sobrescrevem
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          Object.assign(headers, extractFetchHeaders(init.headers));
        } else if (Array.isArray(init.headers)) {
          init.headers.forEach(([key, value]) => {
            headers[key] = value;
          });
        } else if (typeof init.headers === 'object') {
          Object.assign(headers, init.headers);
        }
      }
    } catch (e) {
      // Ignora erros de extração
    }
    return sanitizeHeaders(headers);
  }

  /**
   * Extrai o body do request (para POST, PUT, PATCH)
   */
  async function extractRequestBody(input, init) {
    try {
      let body = init?.body;
      // Se input é Request e não tem body no init
      if (!body && input instanceof Request) {
        try {
          body = await input.clone().text();
        } catch (e) {
          return null;
        }
      }
      if (!body) return null;
      // String
      if (typeof body === 'string') {
        return body.length > MAX_BODY_SIZE
          ? body.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
          : body;
      }
      // FormData
      if (body instanceof FormData) {
        const formDataObj = {};
        body.forEach((value, key) => {
          if (value instanceof File) {
            formDataObj[key] = `[File: ${value.name}, ${value.size} bytes, ${value.type}]`;
          } else {
            formDataObj[key] =
              typeof value === 'string' && value.length > 1000
                ? value.substring(0, 1000) + '...'
                : value;
          }
        });
        return JSON.stringify(formDataObj);
      }
      // URLSearchParams
      if (body instanceof URLSearchParams) {
        return body.toString();
      }
      // Blob
      if (body instanceof Blob) {
        if (body.size > MAX_BODY_SIZE) {
          return `[Blob: ${body.size} bytes, ${body.type}]`;
        }
        try {
          const text = await body.text();
          return text;
        } catch (e) {
          return `[Blob: ${body.size} bytes]`;
        }
      }
      // ArrayBuffer
      if (body instanceof ArrayBuffer) {
        return `[ArrayBuffer: ${body.byteLength} bytes]`;
      }
      // Outros (tentar stringify)
      try {
        const str = JSON.stringify(body);
        return str.length > MAX_BODY_SIZE
          ? str.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
          : str;
      } catch (e) {
        return '[Unserializable Body]';
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * Extrai timing data da Performance API
   */
  function extractPerformanceTiming(url) {
    try {
      if (!window.performance || !window.performance.getEntriesByName) return null;
      // Aguarda um pouco para o entry estar disponível
      const entries = window.performance.getEntriesByName(url, 'resource');
      if (!entries || entries.length === 0) return null;
      const entry = entries[entries.length - 1]; // Pega o mais recente
      if (!entry) return null;
      // Calcula breakdown (valores em ms)
      const dns = Math.round(entry.domainLookupEnd - entry.domainLookupStart);
      const connect = Math.round(entry.connectEnd - entry.connectStart);
      const ssl =
        entry.secureConnectionStart > 0
          ? Math.round(entry.connectEnd - entry.secureConnectionStart)
          : 0;
      const wait = Math.round(entry.responseStart - entry.requestStart); // TTFB
      const download = Math.round(entry.responseEnd - entry.responseStart);
      return {
        dns: Math.max(0, dns),
        connect: Math.max(0, connect),
        ssl: Math.max(0, ssl),
        wait: Math.max(0, wait),
        download: Math.max(0, download),
        total: Math.round(entry.duration),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Processa response body baseado no content-type
   */
  async function processResponseBody(response, clonedResponse) {
    try {
      const contentType = response.headers.get('content-type') || '';
      // Verifica se devemos capturar este tipo de conteúdo
      if (!isCapturableContentType(contentType)) {
        return `[${contentType || 'unknown'} - not captured]`;
      }
      // Verifica tamanho via Content-Length se disponível
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
        return `[Response too large: ${contentLength} bytes]`;
      }
      const text = await clonedResponse.text();
      if (text.length > MAX_BODY_SIZE) {
        return text.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]';
      }
      return text;
    } catch (e) {
      return '[Failed to read response]';
    }
  }

  // ======= Interface Pública =======
  return {
    version: VOIDR_VERSION,

    /**
     * Inicializa o coletor de eventos
     * @param {Object} options - Configurações de inicialização
     * @param {string} options.apiKey - Chave API obrigatória
     * @param {string} [options.applicationId] - ID da aplicação (opcional)
     * @param {string} [options.environment] - Ambiente, ex: "production", "staging" (opcional)
     * @param {Object} [options.user] - Dados do usuário
     * @param {string} [options.collectorUrl] - URL alternativo do coletor
     * @param {boolean} [options.dataMasking] - Configurações de ofuscação
     * @param {number} [options.sessionTimeout] - Tempo de sessão em minutos
     * @param {boolean} [options.system=false] - Flag opcional para indicar execução em contexto de sistema
     * @param {boolean} [options.skipRecording=false] - Força pular gravação (útil para automações)
     * @param {number} [options.samplingRate=0.1] - Taxa de amostragem de 0 a 1 (0% a 100% das sessões, padrão 10%)
     */
    async init(options) {
      // Prevenir inicialização duplicada
      if (isInitialized) {
        console.warn(
          `VoidrCollector v${VOIDR_VERSION} - Already initialized. Skipping duplicate init() call.`,
        );
        return;
      }

      isInitialized = true;

      console.log(`VoidrCollector v${VOIDR_VERSION} - Initializing...`);

      // Validação básica
      if (!options || !options.apiKey) {
        throw new Error('VoidrCollector: API Key é obrigatória');
      }

      // Mesclar configurações
      config = { ...config, ...options };

      // ========== Verificações para pular gravação ==========

      // 1. Verificar skipRecording manual
      if (config.skipRecording === true) {
        console.log('VoidrCollector: Recording skipped (manual override via skipRecording)');
        isInitialized = false;
        return;
      }

      // 2. Detectar ambiente de automação
      if (isAutomationEnvironment()) {
        console.log('VoidrCollector: Recording skipped (automation environment detected)');
        isInitialized = false;
        return;
      }

      // 3. Verificar samplingRate
      if (config.samplingRate < 1) {
        const random = Math.random();
        if (random > config.samplingRate) {
          isInitialized = false;
          return;
        }
      }

      // =======================================================

      // Exigir user.id vindo do config
      if (!config.user || !config.user.id) {
        console.error('VoidrCollector: user.id é obrigatório');
        isInitialized = false;
        return;
      }

      // Inicializar IDs
      sessionStartedAt = Date.now();
      this._initUser();
      this._initSession();

      // Validar apiKey e obter JWT antes de iniciar a biblioteca
      try {
        const storedJwt = sessionStorage.getItem('voidr_jwt');
        const storedSession = sessionStorage.getItem('voidr_session_id');
        const storedUser = sessionStorage.getItem('voidr_user_id');

        if (storedJwt && storedSession && storedUser === userId) {
          authToken = storedJwt;
        } else {
          sessionStorage.removeItem('voidr_jwt');
          sessionStorage.removeItem('voidr_session_id');
          sessionStorage.removeItem('voidr_user_id');

          const response = await fetch(`${config.collectorUrl}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: (() => {
              const initPayload = {
                apiKey: config.apiKey,
                userId,
                userTraits: config.user,
                meta: config.meta,
                system: Boolean(config.system),
                sessionId,
              };
              if (
                config.user &&
                typeof config.user.name === 'string' &&
                config.user.name.length > 0
              ) {
                initPayload.userName = config.user.name;
              }
              if (config.applicationId) initPayload.applicationId = config.applicationId;
              if (config.environment) initPayload.environment = config.environment;
              // URL inicial da página
              try {
                initPayload.initialUrl =
                  typeof window !== 'undefined' && window.location ? window.location.href : null;
              } catch (_) {
                initPayload.initialUrl = null;
              }
              return safeStringify(initPayload);
            })(),
          });

          if (!response.ok) {
            console.error('VoidrCollector: API Key inválida');
            isInitialized = false;
            return;
          }

          const data = await response.json().catch(() => ({}));
          authToken = data.token || null;
          if (!authToken) {
            console.error('VoidrCollector: Falha ao obter token de autenticação');
            isInitialized = false;
            return;
          }
          // Persistir JWT para reutilização em reinits
          try {
            sessionStorage.setItem('voidr_jwt', authToken);
            sessionStorage.setItem('voidr_user_id', userId);
          } catch (_) { }
        }
      } catch (err) {
        console.error('VoidrCollector: Falha ao validar API Key', err);
        isInitialized = false;
        return;
      }

      // Iniciar gravação
      this._startRecording();

      await sleep(2000);
      await this._sendEvents();

      // Configurar envio periódico
      eventsInterval = setInterval(() => {
        this._sendEvents();
        this._sendNetworkEvents();
      }, 7000);

      window.addEventListener('beforeunload', () => this._handleUnload());

      console.log(`VoidrCollector v${VOIDR_VERSION} - Initialized successfully`);
    },

    /**
     * Identifica o usuário atual
     * @param {string} id - ID único do usuário
     * @param {Object} traits - Atributos do usuário
     * @param {string} [traits.email] - Email do usuário
     * @param {string} [traits.name] - Nome do usuário
     */
    identify(id, traits = {}) {
      if (!id) return;

      userId = id;
      sessionStorage.setItem('voidr_user_id', id);

      // Atualizar dados do usuário
      config.user = { ...(config.user || {}), ...traits };

      // Registrar evento de identificação
      events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'user.identify',
          payload: {
            userId: id,
            ...traits,
          },
        },
      });
    },

    /**
     * Atualiza configurações em tempo real
     * @param {Object} updates - Novas configurações
     */
    updateConfig(updates) {
      config = { ...config, ...updates };
    },

    /**
     * Força o fim da sessão atual
     * Para a gravação, limpa intervalos, remove dados do sessionStorage
     * e restaura interceptadores originais
     */
    endSession() {
      // Parar gravação do rrweb
      if (stopRecording && typeof stopRecording === 'function') {
        stopRecording();
        stopRecording = null;
      }

      // Limpar interval principal
      if (eventsInterval) {
        clearInterval(eventsInterval);
        eventsInterval = null;
      }

      // Parar MutationObserver se ativo
      if (observer && typeof observer.disconnect === 'function') {
        observer.disconnect();
        observer = null;
      }

      // Restaurar fetch original
      if (originalFetch && typeof window !== 'undefined') {
        window.fetch = originalFetch;
        originalFetch = null;
      }

      // Restaurar XMLHttpRequest original
      if (originalXHR && typeof window !== 'undefined') {
        window.XMLHttpRequest = originalXHR;
        originalXHR = null;
      }

      // Limpar sessionStorage
      try {
        sessionStorage.removeItem('voidr_jwt');
        sessionStorage.removeItem('voidr_session_id');
        sessionStorage.removeItem('voidr_user_id');
        sessionStorage.removeItem('voidr_last_activity');
      } catch (e) {
        // Ignora erros de sessionStorage
      }

      // Reset das variáveis de estado
      events = [];
      networkBuffer = [];
      sessionStartedAt = null;
      userId = null;
      sessionId = null;
      isSending = false;
      authToken = null;
      lastHref = null;
      forceStop = true;
      isInitialized = false;

      console.log('VoidrCollector: Session ended');
    },

    /**
     * Retorna o ID da sessão atual
     * @returns {string|null} O ID da sessão atual ou null se não inicializado
     */
    getSessionId() {
      return sessionId;
    },

    // ======= Métodos Internos =======
    _initUser() {
      userId = config.user?.id || sessionStorage.getItem('voidr_user_id');
    },

    _initSession() {
      sessionId = sessionStorage.getItem('voidr_session_id');
      const lastActivity = sessionStorage.getItem('voidr_last_activity');
      const sessionExpired = lastActivity
        ? Date.now() - parseInt(lastActivity) > config.sessionTimeout * 60 * 1000
        : true;

      if (!sessionId || sessionExpired) {
        sessionId = sessionStartedAt.toString();
        sessionStorage.setItem('voidr_session_id', sessionId);
      }

      sessionStorage.setItem('voidr_last_activity', Date.now());
    },

    _startRecording() {
      // Inicializar plugins
      const plugins = [];
      if (config.captureConsole) {
        plugins.push(
          getRecordConsolePlugin({
            level: ['log', 'warn', 'error', 'info'],
          }),
        );
      }

      // Build maskTextSelector: global mask > TASY hotfix > null
      const maskTextSelector = config.dataMasking.text
        ? '*'
        : isTasy
          ? TASY_MASK_SELECTORS.join(', ')
          : null;
          //To test locally, change null for a string of selectors. Example: 'h2, h3, p, .font-medium';

      // Iniciar gravação do rrweb
      stopRecording = record({
        emit: (event) => events.push(event),
        plugins,
        recordCanvas: true,
        recordCrossOriginIframes: true,
        inlineStylesheet: true,
        inlineImages: false,
        maskTextSelector,
        maskAllInputs: isTasy || config.dataMasking.inputs,
        blockSelector: config.dataMasking.blockSelectors?.join(', '),
        checkoutEveryNms: 120000,
        checkoutEveryNth: 1000,
        dataURLOptions: {
          type: 'image/webp',
          quality: 0.4,
        },
        sampling: {
          mousemove: 100,
          mouseInteraction: true,
          input: 'all',
          scroll: 250,
          canvas: 2,
        },
        slimDOMOptions: 'all',
      });

      // Iniciar listeners de eventos customizados
      this._initEventListeners();
      this._initNetworkCapture();
      this._initErrorTracking();
      this._initRoutingCapture();
      // if (config.uiHeuristics?.enabled) {
      this._initUISnapshotHeuristics();
      // }
    },

    _initNetworkCapture() {
      if (!config.networkCapture) return;

      // 🔥 Fetch interceptado
      originalFetch = window.fetch;
      window.fetch = async function (...args) {
        const [input, init] = args;
        let requestUrl = typeof input === 'string' ? input : input.url;
        if (!requestUrl) {
          return originalFetch(...args);
        }

        if (!requestUrl.startsWith('http')) {
          try {
            requestUrl = new URL(requestUrl, window.location.origin).toString();
          } catch (_) {
            requestUrl = `${window.location.origin}${requestUrl}`;
          }
        }

        // Normaliza a URL base do collector a partir da configuração do módulo
        const normalizedCollectorBase =
          config && typeof config.collectorUrl === 'string'
            ? config.collectorUrl.replace(/\/+$/, '')
            : '';
        const isCollectorRequest = (() => {
          try {
            return (
              requestUrl &&
              normalizedCollectorBase &&
              requestUrl.startsWith(normalizedCollectorBase)
            );
          } catch (_) {
            return Boolean(
              requestUrl && normalizedCollectorBase && requestUrl.includes(normalizedCollectorBase),
            );
          }
        })();

        // Se é request do próprio collector, não intercepta
        if (isCollectorRequest) {
          return originalFetch(...args);
        }

        const start = Date.now();
        const method = init?.method || (input instanceof Request ? input.method : 'GET');

        // Captura request headers e body ANTES de fazer a requisição
        const requestHeaders = extractRequestHeaders(input, init);
        let requestBody = null;
        if (['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
          requestBody = await extractRequestBody(input, init);
        }

        try {
          const response = await originalFetch(...args);
          const cloned = response.clone();

          // Processa response de forma assíncrona
          processResponseBody(response, cloned).then((responseBody) => {
            // Extrai response headers
            const responseHeaders = sanitizeHeaders(extractFetchHeaders(response.headers));

            // Tenta obter timing data (delay pequeno para entry estar disponível)
            setTimeout(() => {
              const timing = extractPerformanceTiming(requestUrl);

              VoidrCollector._logNetworkEvent({
                type: 'fetch',
                url: requestUrl,
                method: method.toUpperCase(),
                status: response.status,
                statusText: response.statusText,
                duration: Date.now() - start,
                thirdParty: isThirdParty(requestUrl),
                origin: window.location.origin,
                // Novos campos
                requestHeaders,
                responseHeaders,
                requestBody,
                responseBody,
                timing,
                responseSize: responseBody ? responseBody.length : 0,
              });
            }, 50);
          });

          return response;
        } catch (error) {
          VoidrCollector._logNetworkEvent({
            type: 'fetchError',
            url: requestUrl,
            method: method.toUpperCase(),
            error: error.message,
            thirdParty: isThirdParty(requestUrl),
            origin: window.location.origin,
            requestHeaders,
            requestBody,
          });
          throw error;
        }
      };

      // 🔥 XHR interceptado
      originalXHR = window.XMLHttpRequest;

      function InterceptedXHR() {
        const xhr = new originalXHR();
        const originalOpen = xhr.open;
        const originalSend = xhr.send;
        const originalSetRequestHeader = xhr.setRequestHeader;

        let method = '';
        let url = '';
        let requestHeaders = {};
        let requestBody = null;

        xhr.open = function (_method, _url) {
          method = _method;
          url = _url;
          // Normaliza URL
          if (url && !url.startsWith('http')) {
            try {
              url = new URL(url, window.location.origin).toString();
            } catch (_) {
              url = `${window.location.origin}${url}`;
            }
          }
          return originalOpen.apply(this, arguments);
        };

        xhr.setRequestHeader = function (header, value) {
          requestHeaders[header] = value;
          return originalSetRequestHeader.apply(this, arguments);
        };

        xhr.send = function (body) {
          const start = Date.now();

          // Captura request body
          if (body !== null && body !== undefined) {
            if (typeof body === 'string') {
              requestBody =
                body.length > MAX_BODY_SIZE
                  ? body.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
                  : body;
            } else if (body instanceof FormData) {
              const formDataObj = {};
              body.forEach((value, key) => {
                if (value instanceof File) {
                  formDataObj[key] = `[File: ${value.name}, ${value.size} bytes, ${value.type}]`;
                } else {
                  formDataObj[key] =
                    typeof value === 'string' && value.length > 1000
                      ? value.substring(0, 1000) + '...'
                      : value;
                }
              });
              requestBody = JSON.stringify(formDataObj);
            } else if (body instanceof URLSearchParams) {
              requestBody = body.toString();
            } else if (body instanceof Blob) {
              requestBody = `[Blob: ${body.size} bytes, ${body.type}]`;
            } else if (body instanceof ArrayBuffer) {
              requestBody = `[ArrayBuffer: ${body.byteLength} bytes]`;
            } else {
              try {
                requestBody = JSON.stringify(body);
              } catch (e) {
                requestBody = '[Unserializable Body]';
              }
            }
          }

          const baseCollectorUrl =
            config && typeof config.collectorUrl === 'string'
              ? config.collectorUrl.replace(/\/+$/, '')
              : '';
          const isCollectorRequest = url && baseCollectorUrl && url.startsWith(baseCollectorUrl);

          if (isCollectorRequest) {
            return originalSend.apply(this, arguments);
          }

          this.addEventListener('loadend', () => {
            // Extrai response headers
            const responseHeadersRaw = this.getAllResponseHeaders();
            const responseHeaders = {};
            if (responseHeadersRaw) {
              responseHeadersRaw.split('\r\n').forEach((line) => {
                const parts = line.split(': ');
                if (parts.length >= 2) {
                  const key = parts.shift();
                  const value = parts.join(': ');
                  if (key) responseHeaders[key] = value;
                }
              });
            }

            // Processa response body baseado no content-type
            const contentType = this.getResponseHeader('content-type') || '';
            let responseBody = null;
            if (isCapturableContentType(contentType)) {
              const responseText = this.responseText || '';
              responseBody =
                responseText.length > MAX_BODY_SIZE
                  ? responseText.substring(0, MAX_BODY_SIZE) + '...[TRUNCATED]'
                  : responseText;
            } else {
              responseBody = `[${contentType || 'unknown'} - not captured]`;
            }

            // Tenta obter timing data
            setTimeout(() => {
              const timing = extractPerformanceTiming(url);

              VoidrCollector._logNetworkEvent({
                type: 'xhr',
                url: url,
                method: method.toUpperCase(),
                status: this.status,
                statusText: this.statusText,
                duration: Date.now() - start,
                thirdParty: isThirdParty(url),
                origin: window.location.origin,
                // Novos campos
                requestHeaders: sanitizeHeaders(requestHeaders),
                responseHeaders: sanitizeHeaders(responseHeaders),
                requestBody,
                responseBody,
                timing,
                responseSize: responseBody ? responseBody.length : 0,
              });
            }, 50);
          });

          return originalSend.apply(this, arguments);
        };

        return xhr;
      }

      window.XMLHttpRequest = InterceptedXHR;
    },

    _initEventListeners() {
      // 🔥 MutationObserver para mudanças no DOM
      // observer = new MutationObserver((mutations) => {
      //   mutations.forEach((mutation) => {
      //     if (mutation.type === 'childList') {
      //       mutation.addedNodes.forEach((node) => {
      //         if (node.nodeType === 1) {
      //           events.push({
      //             type: 5,
      //             timestamp: Date.now(),
      //             data: {
      //               plugin: 'dom.change',
      //               payload: {
      //                 type: 'nodeAdded',
      //                 selector: generateSelector(node),
      //                 tag: node.tagName,
      //                 text: getTextContent(node),
      //               },
      //             },
      //           });
      //         }
      //       });
      //     }
      //   });
      // });

      // observer.observe(document, {
      //   childList: true,
      //   subtree: true,
      //   attributes: false,
      //   characterData: false,
      // });

      // HOTFIX: helper to check if element matches TASY mask selectors (remove with hotfix)
      const _isTasyMasked = (el) => {
        if (!isTasy || !el) return false;
        const sel = TASY_MASK_SELECTORS.join(', ');
        try { return el.matches(sel) || !!el.closest(sel); } catch { return false; }
      };

      // 🔥 Eventos de input e change
      document.addEventListener('input', (e) => {
        const target = e.target;
        if (shouldIgnore(target)) return;

        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'user.input',
            payload: {
              selector: generateSelector(target),
              tag: target.tagName,
              value: _isTasyMasked(target) ? '***' : truncate(target.value, 100),
              type: target.type,
            },
          },
        });
      });

      document.addEventListener('change', (e) => {
        const target = e.target;
        if (shouldIgnore(target)) return;

        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'user.change',
            payload: {
              selector: generateSelector(target),
              tag: target.tagName,
              value: _isTasyMasked(target) ? '***' : truncate(target.value, 100),
              type: target.type,
            },
          },
        });
      });

      // 🔥 Cliques
      document.addEventListener('click', (e) => {
        const target = e.composedPath()[0];
        if (shouldIgnore(target)) return;

        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'user.click',
            payload: {
              selector: generateSelector(target),
              tag: target.tagName,
              text: _isTasyMasked(target) ? '***' : getTextContent(target),
              position: {
                x: e.clientX,
                y: e.clientY,
              },
            },
          },
        });
      });

      // 🔥 Scroll com throttling
      const scrollHandler = throttle(() => {
        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'user.scroll',
            payload: {
              x: window.scrollX,
              y: window.scrollY,
            },
          },
        });
      }, 200);

      window.addEventListener('scroll', scrollHandler);
    },

    _initRoutingCapture() {
      try {
        lastHref = typeof window !== 'undefined' && window.location ? window.location.href : null;

        // Captura a página inicial assim que a gravação começa
        const captureInitialPage = () => {
          try {
            const title = document.title || '';
            const url = window.location.href;
            events.push({
              type: 5,
              timestamp: Date.now(),
              data: {
                plugin: 'page.view',
                payload: {
                  url,
                  title,
                  trigger: 'initial',
                },
              },
            });
          } catch (_) { }
        };

        // Captura a página inicial após um pequeno delay para garantir que o título está carregado
        setTimeout(captureInitialPage, 100);

        const onRouteChange = (trigger) => {
          const current = window.location.href;
          if (!current || current === lastHref) return;
          const from = lastHref;
          lastHref = current;

          // Captura o título da página atual (com pequeno delay para SPAs atualizarem o título)
          setTimeout(() => {
            const title = document.title || '';
            events.push({
              type: 5,
              timestamp: Date.now(),
              data: {
                plugin: 'page.view',
                payload: {
                  url: current,
                  title,
                  from,
                  trigger,
                },
              },
            });
          }, 50);

          // Evento custom do rrweb para indicar troca de rota
          try {
            if (typeof record?.addCustomEvent === 'function') {
              record.addCustomEvent('route', { from, to: current, trigger });
            }
          } catch (_) { }

          // Força um full snapshot para garantir que o player reflita a nova UI
          try {
            if (typeof record?.takeFullSnapshot === 'function') {
              record.takeFullSnapshot();
            }
          } catch (_) { }
        };

        const origPushState = history.pushState;
        const origReplaceState = history.replaceState;

        history.pushState = function () {
          const result = origPushState.apply(this, arguments);
          onRouteChange('pushState');
          return result;
        };

        history.replaceState = function () {
          const result = origReplaceState.apply(this, arguments);
          onRouteChange('replaceState');
          return result;
        };

        window.addEventListener('popstate', () => onRouteChange('popstate'));
        window.addEventListener('hashchange', () => onRouteChange('hashchange'));
      } catch (err) {
        // noop
      }
    },

    _initUISnapshotHeuristics() {
      try {
        const options = {
          mutationThreshold: config?.uiHeuristics?.mutationThreshold || 50,
          debounceMs: 400,
        };

        const scheduleSnapshot = debounce((reason) => {
          record.takeFullSnapshot();
        }, options.debounceMs);

        // Heurística 1: grande volume de mutações em curto intervalo
        const mo = new MutationObserver((mutationList) => {
          let score = 0;
          for (const m of mutationList) {
            score += (m.addedNodes?.length || 0) + (m.removedNodes?.length || 0);
            if (m.type === 'attributes' || m.type === 'characterData') score += 1;
          }
          if (score >= options.mutationThreshold) {
            scheduleSnapshot('mutationThreshold');
          }
        });
        mo.observe(document, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch (_) {
        // noop
      }
    },

    _initErrorTracking() {
      // 🔥 Erros globais
      window.addEventListener('error', (e) => {
        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'window.error',
            payload: {
              message: e.message,
              stack: e.error && e.error.stack,
              filename: e.filename,
              position: `${e.lineno}:${e.colno}`,
            },
          },
        });
      });

      // 🔥 Promise rejections
      window.addEventListener('unhandledrejection', (e) => {
        events.push({
          type: 5,
          timestamp: Date.now(),
          data: {
            plugin: 'promise.rejection',
            payload: {
              reason: e.reason ? e.reason.toString() : 'Unknown error',
            },
          },
        });
      });
    },

    _logNetworkEvent(data) {
      networkBuffer.push(data);
      if (networkBuffer.length > 10) this._sendNetworkEvents();
    },

    async _sendEvents() {
      const MIN_BATCH_SIZE = 10;
      if (isSending || events.length < MIN_BATCH_SIZE || forceStop) return;
      isSending = true;

      const batch = events.splice(0, 100);
      const compressedBatch = await compressEventsBase64(batch);

      const startedAt = compressedBatch[0]?.timestamp ?? Date.now();
      const endedAt =
        compressedBatch[compressedBatch.length - 1]?.timestamp ?? Date.now();

      const payload = {
        userId,
        sessionId,
        userTraits: config.user,
        events: compressedBatch,
        maskedElements: config.dataMasking.blockSelectors,
        sessionTimeout: config.sessionTimeout,
        startedAt,
        endedAt,
        meta: config.meta,
        applicationId: config.applicationId,
        environment: config.environment,
      };

      try {
        const compressed = gzip(safeStringify(payload));

        let res = await fetch(`${config.collectorUrl}/sessions/chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: compressed,
        });

        // Handle 401 - refresh token and retry
        if (res.status === 401) {
          const refreshResponse = await fetch(`${config.collectorUrl}/refresh-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeStringify({
              apiKey: config.apiKey,
            }),
          });
          if (!refreshResponse.ok) {
            throw new Error('VoidrCollector: Failed to refresh token');
          }
          const data = await refreshResponse.json().catch(() => ({}));
          authToken = data.token || null;
          if (!authToken) {
            throw new Error('VoidrCollector: Failed to refresh token');
          }
          sessionStorage.setItem('voidr_jwt', authToken);
          // Retry the original request with new token
          res = await fetch(`${config.collectorUrl}/sessions/chunk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              Authorization: `Bearer ${authToken}`,
            },
            body: compressed,
          });
        }

        if (!res.ok) {
          throw new Error('VoidrCollector: Failed to send events');
        }
      } catch (error) {
        console.error('VoidrCollector: Failed to send events', error);
        stopRecording();
        forceStop = true;
        sessionStorage.removeItem('voidr_session_id');
        sessionStorage.removeItem('voidr_user_id');
        sessionStorage.removeItem('voidr_jwt');
        clearInterval(eventsInterval);
        events.unshift(...batch);
      } finally {
        isSending = false;
      }
    },

    _sendNetworkEvents() {
      if (networkBuffer.length === 0) return;

      events.push({
        type: 5,
        timestamp: Date.now(),
        data: {
          plugin: 'network.batch',
          payload: {
            requests: networkBuffer.splice(0),
          },
        },
      });
    },

    _handleUnload() {
      this._sendNetworkEvents();
      // Respeitar mínimo de eventos antes de enviar
      this._sendEvents();

      // Envio síncrono como fallback (usa XMLHttpRequest original para não logar como evento de rede)
      if (events.length > 0) {
        const payload = {
          apiKey: config.apiKey,
          userId,
          sessionId,
          events,
          meta: config.meta,
          applicationId: config.applicationId,
          environment: config.environment,
        };

        const XHRConstructor = originalXHR || XMLHttpRequest;
        const xhr = new XHRConstructor();
        xhr.open('POST', `${config.collectorUrl}/sessions/chunk`, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (authToken) {
          xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        }
        xhr.send(safeStringify(payload));
      }
    },
  };
})();

// Wrapper global para capturar qualquer erro
const SafeVoidrCollector = new Proxy(VoidrCollector, {
  get(target, prop) {
    const value = target[prop];

    // Se não for uma função, retorna direto
    if (typeof value !== 'function') {
      return value;
    }

    // Envolve funções em try-catch
    return function (...args) {
      try {
        const result = value.apply(target, args);

        // Se for Promise, captura erros async também
        if (result && typeof result.then === 'function') {
          return result.catch((error) => {
            console.error(`VoidrCollector: Error in ${String(prop)}:`, error);
            return undefined;
          });
        }

        return result;
      } catch (error) {
        console.error(`VoidrCollector: Error in ${String(prop)}:`, error);
        return undefined;
      }
    };
  },
});

export default SafeVoidrCollector;

if (typeof window !== 'undefined') {
  window.VoidrCollector = SafeVoidrCollector;
  console.log(`VoidrCollector v${VOIDR_VERSION} - Module loaded`);
}
