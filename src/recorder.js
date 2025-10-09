import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    collectorUrl: 'https://collector.voidr.co',
    sessionTimeout: 30, // minutos
    system: false,
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
  let foceStop = false;
  let eventsInterval = null;
  let originalFetch = null;
  let originalXHR = null;

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

  function isThirdParty(url) {
    try {
      const currentHost = window.location.hostname;
      const targetHost = new URL(url).hostname;
      return !targetHost.endsWith(currentHost);
    } catch (e) {
      return false;
    }
  }

  // ======= Interface Pública =======
  return {
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
     */
    async init(options) {
      // Validação básica
      if (!options || !options.apiKey) {
        throw new Error('VoidrCollector: API Key é obrigatória');
      }

      // Mesclar configurações
      config = { ...config, ...options };

      // Exigir user.id vindo do config
      if (!config.user || !config.user.id) {
        console.error('VoidrCollector: user.id é obrigatório');
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
            return;
          }

          const data = await response.json().catch(() => ({}));
          authToken = data.token || null;
          if (!authToken) {
            console.error('VoidrCollector: Falha ao obter token de autenticação');
            return;
          }
          // Persistir JWT para reutilização em reinits
          try {
            sessionStorage.setItem('voidr_jwt', authToken);
            sessionStorage.setItem('voidr_user_id', userId);
          } catch (_) {}
        }
      } catch (err) {
        console.error('VoidrCollector: Falha ao validar API Key', err);
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
      foceStop = true;

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

      // Iniciar gravação do rrweb
      stopRecording = record({
        emit: (event) => events.push(event),
        plugins,
        recordCanvas: true,
        recordCrossOriginIframes: true,
        inlineStylesheet: true,
        maskTextSelector: config.dataMasking.text ? '*' : null,
        maskAllInputs: config.dataMasking.inputs,
        blockSelector: config.dataMasking.blockSelectors?.join(', '),
        checkoutEveryNms: 60000, // snapshot completo a cada 60s
        checkoutEveryNth: 1000, // snapshot completo a cada 1000 eventos
        sampling: {
          mousemove: 100,
          mouseInteraction: true,
          input: 'all',
          scroll: 250,
        },
        slimDOMOptions: 'all',
      });

      // Iniciar listeners de eventos customizados
      this._initEventListeners();
      this._initNetworkCapture();
      this._initErrorTracking();
      // this._initRoutingCapture();
      // if (config.uiHeuristics?.enabled) {
      this._initUISnapshotHeuristics();
      // }
    },

    _initNetworkCapture() {
      if (!config.networkCapture) return;

      // 🔥 Fetch interceptado
      originalFetch = window.fetch;
      window.fetch = async function (...args) {
        const [url, requestConfig] = args;
        let requestUrl = typeof url === 'string' ? url : url.url;
        if (!requestUrl) {
          return;
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

        const start = Date.now();

        try {
          const response = await originalFetch(...args);
          const cloned = response.clone();

          cloned.text().then((body) => {
            if (!isCollectorRequest) {
              VoidrCollector._logNetworkEvent({
                type: 'fetch',
                url: requestUrl,
                method: requestConfig && requestConfig.method ? requestConfig.method : 'GET',
                status: response.status,
                duration: Date.now() - start,
                response: truncate(body, 2000),
                thirdParty: isThirdParty(requestUrl),
                origin: window.location.origin,
              });
            }
          });

          return response;
        } catch (error) {
          if (!isCollectorRequest) {
            VoidrCollector._logNetworkEvent({
              type: 'fetchError',
              url: requestUrl,
              error: error.message,
              thirdParty: isThirdParty(requestUrl),
              origin: window.location.origin,
            });
          }
          throw error;
        }
      };

      // 🔥 XHR interceptado
      originalXHR = window.XMLHttpRequest;

      function InterceptedXHR() {
        const xhr = new originalXHR();
        const open = xhr.open;
        const send = xhr.send;
        let method = '';
        let url = '';

        xhr.open = function (_method, _url) {
          method = _method;
          url = _url;
          return open.apply(this, arguments);
        };

        xhr.send = function (body) {
          const start = Date.now();

          this.addEventListener('loadend', () => {
            const baseCollectorUrl =
              config && typeof config.collectorUrl === 'string'
                ? config.collectorUrl.replace(/\/+$/, '')
                : '';
            const isCollectorRequest = url && baseCollectorUrl && url.startsWith(baseCollectorUrl);
            if (!isCollectorRequest) {
              VoidrCollector._logNetworkEvent({
                type: 'xhr',
                url: url,
                method: method,
                status: this.status,
                duration: Date.now() - start,
                response: truncate(this.responseText, 2000),
                thirdParty: isThirdParty(url),
                origin: window.location.origin,
              });
            }
          });

          return send.apply(this, arguments);
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
              value: truncate(target.value, 100),
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
              value: truncate(target.value, 100),
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
              text: getTextContent(target),
              position: {
                x: e.clientX,
                y: e.clientY,
              },
            },
          },
        });
      });

      // 🔥 Scroll com throttling
      let lastScroll = 0;
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

        const onRouteChange = (trigger) => {
          const current = window.location.href;
          if (!current || current === lastHref) return;
          const from = lastHref;
          lastHref = current;

          // Evento custom do rrweb para indicar troca de rota
          try {
            if (typeof record?.addCustomEvent === 'function') {
              record.addCustomEvent('route', { from, to: current, trigger });
            }
          } catch (_) {}

          // Força um full snapshot para garantir que o player reflita a nova UI
          try {
            if (typeof record?.takeFullSnapshot === 'function') {
              record.takeFullSnapshot();
            }
          } catch (_) {}
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
      if (isSending || events.length < MIN_BATCH_SIZE || foceStop) return;
      isSending = true;

      const batch = events.splice(0, 100);

      const startedAt = batch[0]?.timestamp ?? Date.now();
      const endedAt = batch[batch.length - 1]?.timestamp ?? Date.now();

      const payload = {
        userId,
        sessionId,
        userTraits: config.user,
        events: batch,
        maskedElements: config.dataMasking.blockSelectors,
        sessionTimeout: config.sessionTimeout,
        startedAt,
        endedAt,
      };

      try {
        const res = await fetch(`${config.collectorUrl}/sessions/chunk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: safeStringify(payload),
        });

        if (!res.ok) {
          throw new Error('VoidrCollector: Failed to send events');
        }

        if (res.status === 401) {
          const response = await fetch(`${config.collectorUrl}/refresh-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeStringify({
              apiKey: config.apiKey,
            }),
          });
          if (!response.ok) {
            throw new Error('VoidrCollector: Failed to refresh token');
          }
          const data = await response.json().catch(() => ({}));
          authToken = data.token || null;
          if (!authToken) {
            throw new Error('VoidrCollector: Failed to refresh token');
          }
          sessionStorage.setItem('voidr_jwt', authToken);
        }
      } catch (error) {
        console.error('VoidrCollector: Failed to send events', error);
        stopRecording();
        foceStop = true;
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

      // Envio síncrono como fallback
      if (events.length > 0) {
        const payload = {
          apiKey: config.apiKey,
          userId,
          sessionId,
          events,
        };

        const xhr = new XMLHttpRequest();
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
}
