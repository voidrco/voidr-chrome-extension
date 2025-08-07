// import { record } from "rrweb";
// import { getRecordConsolePlugin } from "@rrweb/rrweb-plugin-console-record";

// const VoidrCollector = (function () {
//   // ======= Configurações Internas =======
//   let config = {
//     apiKey: null,
//     collectorUrl: "https://collector.voidr.co",
//     sessionTimeout: 30, // minutos
//     dataMasking: {
//       text: false,
//       inputs: false,
//       blockSelectors: ['[data-sensitivity="block"]'],
//     },
//     networkCapture: true,
//     captureConsole: true,
//     user: null,
//   };

//   let events = [];
//   let networkBuffer = [];
//   let sessionStartedAt = null;
//   let userId = null;
//   let sessionId = null;
//   let stopRecording = null;
//   let isSending = false;
//   let observer = null;

//   // ======= Funções Auxiliares =======
//   function generateSelector(el, maxDepth = 6) {
//     if (!el || maxDepth === 0) return "";
//     const parts = [];
//     let current = el;

//     for (let i = 0; i < maxDepth && current && current.nodeType === 1; i++) {
//       let selector = current.tagName.toLowerCase();

//       if (current.id) {
//         selector += `#${current.id}`;
//         parts.unshift(selector);
//         break;
//       } else {
//         const siblings = Array.from(
//           current.parentNode ? current.parentNode.children : [],
//         );
//         const sameTag = siblings.filter((s) => s.tagName === current.tagName);

//         if (sameTag.length > 1) {
//           const index = siblings.indexOf(current) + 1;
//           selector += `:nth-child(${index})`;
//         }
//       }

//       parts.unshift(selector);
//       current = current.parentElement;
//     }

//     return parts.join(" > ");
//   }

//   function shouldIgnore(el) {
//     if (!el.closest) return false;

//     // Verificar seletor global + seletores customizados
//     const selectors = [
//       '[data-sensitivity="block"]',
//       ...(config.dataMasking.blockSelectors || []),
//     ].join(",");

//     return el.closest(selectors);
//   }

//   function getTextContent(el) {
//     return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
//   }

//   function throttle(fn, delay) {
//     let lastCall = 0;
//     return function (...args) {
//       const now = Date.now();
//       if (now - lastCall >= delay) {
//         fn.apply(this, args);
//         lastCall = now;
//       }
//     };
//   }

//   function truncate(text, maxLength) {
//     if (typeof text !== "string") return "";
//     return text.length > maxLength
//       ? text.substring(0, maxLength) + "..."
//       : text;
//   }

//   function isThirdParty(url) {
//     try {
//       const currentHost = window.location.hostname;
//       const targetHost = new URL(url).hostname;
//       return !targetHost.endsWith(currentHost);
//     } catch (e) {
//       return false;
//     }
//   }

//   // ======= Interface Pública =======
//   return {
//     /**
//      * Inicializa o coletor de eventos
//      * @param {Object} options - Configurações de inicialização
//      * @param {string} options.apiKey - Chave API obrigatória
//      * @param {Object} [options.user] - Dados do usuário
//      * @param {string} [options.collectorUrl] - URL alternativo do coletor
//      * @param {boolean} [options.dataMasking] - Configurações de ofuscação
//      * @param {number} [options.sessionTimeout] - Tempo de sessão em minutos
//      */
//     init(options) {
//       // Validação básica
//       if (!options || !options.apiKey) {
//         throw new Error("VoidrCollector: API Key é obrigatória");
//       }

//       // Mesclar configurações
//       config = { ...config, ...options };

//       // Inicializar IDs
//       sessionStartedAt = Date.now();
//       this._initUser();
//       this._initSession();

//       // Iniciar gravação
//       this._startRecording();

//       // Configurar envio periódico
//       setInterval(() => {
//         this._sendEvents();
//         this._sendNetworkEvents();
//       }, 10000);

//       window.addEventListener("beforeunload", () => this._handleUnload());
//     },

//     /**
//      * Identifica o usuário atual
//      * @param {string} id - ID único do usuário
//      * @param {Object} traits - Atributos do usuário
//      * @param {string} [traits.email] - Email do usuário
//      * @param {string} [traits.name] - Nome do usuário
//      */
//     identify(id, traits = {}) {
//       if (!id) return;

//       userId = id;
//       localStorage.setItem("voidr_user_id", id);

//       // Atualizar dados do usuário
//       config.user = { ...(config.user || {}), ...traits };

//       // Registrar evento de identificação
//       events.push({
//         type: 5,
//         timestamp: Date.now(),
//         data: {
//           plugin: "user.identify",
//           payload: {
//             userId: id,
//             ...traits,
//           },
//         },
//       });
//     },

//     /**
//      * Atualiza configurações em tempo real
//      * @param {Object} updates - Novas configurações
//      */
//     updateConfig(updates) {
//       config = { ...config, ...updates };
//     },

//     // ======= Métodos Internos =======
//     _initUser() {
//       userId = config.user?.id || localStorage.getItem("voidr_user_id");
//       if (!userId) {
//         userId = crypto.randomUUID();
//         localStorage.setItem("voidr_user_id", userId);
//       }
//     },

//     _initSession() {
//       sessionId = sessionStorage.getItem("voidr_session_id");
//       const lastActivity = localStorage.getItem("voidr_last_activity");
//       const sessionExpired = lastActivity
//         ? Date.now() - parseInt(lastActivity) >
//           config.sessionTimeout * 60 * 1000
//         : true;

//       if (!sessionId || sessionExpired) {
//         sessionId = sessionStartedAt.toString();
//         sessionStorage.setItem("voidr_session_id", sessionId);
//       }

//       localStorage.setItem("voidr_last_activity", Date.now());
//     },

//     _startRecording() {
//       // Inicializar plugins
//       const plugins = [];
//       if (config.captureConsole) {
//         plugins.push(
//           getRecordConsolePlugin({
//             level: ["log", "warn", "error", "info"],
//           }),
//         );
//       }

//       // Iniciar gravação do rrweb
//       stopRecording = record({
//         emit: (event) => events.push(event),
//         plugins,
//         recordCanvas: true,
//         recordCrossOriginIframes: true,
//         inlineStylesheet: true,
//         maskTextSelector: config.dataMasking.text ? "*" : null,
//         maskAllInputs: config.dataMasking.inputs,
//         blockSelector: config.dataMasking.blockSelectors?.join(", "),
//         sampling: {
//           mousemove: 50,
//           mouseInteraction: true,
//           input: "all",
//           scroll: 150,
//         },
//         slimDOMOptions: "all",
//       });

//       // Iniciar listeners de eventos customizados
//       this._initEventListeners();
//       this._initNetworkCapture();
//       this._initErrorTracking();
//     },

//     _initEventListeners() {
//       // 🔥 MutationObserver para mudanças no DOM
//       observer = new MutationObserver((mutations) => {
//         mutations.forEach((mutation) => {
//           if (mutation.type === "childList") {
//             mutation.addedNodes.forEach((node) => {
//               if (node.nodeType === 1) {
//                 events.push({
//                   type: 5,
//                   timestamp: Date.now(),
//                   data: {
//                     plugin: "dom.change",
//                     payload: {
//                       type: "nodeAdded",
//                       selector: generateSelector(node),
//                       tag: node.tagName,
//                       text: getTextContent(node),
//                     },
//                   },
//                 });
//               }
//             });
//           }
//         });
//       });

//       observer.observe(document, {
//         childList: true,
//         subtree: true,
//         attributes: false,
//         characterData: false,
//       });

//       // 🔥 Eventos de input e change
//       document.addEventListener("input", (e) => {
//         const target = e.target;
//         if (shouldIgnore(target)) return;

//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "user.input",
//             payload: {
//               selector: generateSelector(target),
//               tag: target.tagName,
//               value: truncate(target.value, 100),
//               type: target.type,
//             },
//           },
//         });
//       });

//       document.addEventListener("change", (e) => {
//         const target = e.target;
//         if (shouldIgnore(target)) return;

//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "user.change",
//             payload: {
//               selector: generateSelector(target),
//               tag: target.tagName,
//               value: truncate(target.value, 100),
//               type: target.type,
//             },
//           },
//         });
//       });

//       // 🔥 Cliques
//       document.addEventListener("click", (e) => {
//         const target = e.composedPath()[0];
//         if (shouldIgnore(target)) return;

//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "user.click",
//             payload: {
//               selector: generateSelector(target),
//               tag: target.tagName,
//               text: getTextContent(target),
//               position: {
//                 x: e.clientX,
//                 y: e.clientY,
//               },
//             },
//           },
//         });
//       });

//       // 🔥 Scroll com throttling
//       let lastScroll = 0;
//       const scrollHandler = throttle(() => {
//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "user.scroll",
//             payload: {
//               x: window.scrollX,
//               y: window.scrollY,
//             },
//           },
//         });
//       }, 200);

//       window.addEventListener("scroll", scrollHandler);
//     },

//     _initNetworkCapture() {
//       if (!config.networkCapture) return;

//       // 🔥 Fetch interceptado
//       const originalFetch = window.fetch;
//       window.fetch = async function (...args) {
//         const [url, config] = args;
//         const requestUrl = typeof url === "string" ? url : url.url;
//         const start = Date.now();

//         try {
//           const response = await originalFetch(...args);
//           const cloned = response.clone();

//           cloned.text().then((body) => {
//             VoidrCollector._logNetworkEvent({
//               type: "fetch",
//               url: requestUrl,
//               method: config && config.method ? config.method : "GET",
//               status: response.status,
//               duration: Date.now() - start,
//               response: truncate(body, 2000),
//               thirdParty: isThirdParty(requestUrl),
//               origin: window.location.origin,
//             });
//           });

//           return response;
//         } catch (error) {
//           VoidrCollector._logNetworkEvent({
//             type: "fetchError",
//             url: requestUrl,
//             error: error.message,
//             thirdParty: isThirdParty(requestUrl),
//             origin: window.location.origin,
//           });
//           throw error;
//         }
//       };

//       // 🔥 XHR interceptado
//       const originalXHR = window.XMLHttpRequest;

//       function InterceptedXHR() {
//         const xhr = new originalXHR();
//         const open = xhr.open;
//         const send = xhr.send;
//         let method = "";
//         let url = "";

//         xhr.open = function (_method, _url) {
//           method = _method;
//           url = _url;
//           return open.apply(this, arguments);
//         };

//         xhr.send = function (body) {
//           const start = Date.now();

//           this.addEventListener("loadend", () => {
//             VoidrCollector._logNetworkEvent({
//               type: "xhr",
//               url: url,
//               method: method,
//               status: this.status,
//               duration: Date.now() - start,
//               response: truncate(this.responseText, 2000),
//               thirdParty: isThirdParty(url),
//               origin: window.location.origin,
//             });
//           });

//           return send.apply(this, arguments);
//         };

//         return xhr;
//       }

//       window.XMLHttpRequest = InterceptedXHR;
//     },

//     _initErrorTracking() {
//       // 🔥 Erros globais
//       window.addEventListener("error", (e) => {
//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "window.error",
//             payload: {
//               message: e.message,
//               stack: e.error && e.error.stack,
//               filename: e.filename,
//               position: `${e.lineno}:${e.colno}`,
//             },
//           },
//         });
//       });

//       // 🔥 Promise rejections
//       window.addEventListener("unhandledrejection", (e) => {
//         events.push({
//           type: 5,
//           timestamp: Date.now(),
//           data: {
//             plugin: "promise.rejection",
//             payload: {
//               reason: e.reason ? e.reason.toString() : "Unknown error",
//             },
//           },
//         });
//       });
//     },

//     _logNetworkEvent(data) {
//       networkBuffer.push(data);
//       if (networkBuffer.length > 10) this._sendNetworkEvents();
//     },

//     _sendEvents() {
//       if (isSending || events.length === 0) return;
//       isSending = true;

//       const batch = events.splice(0, 100);
//       const payload = {
//         apiKey: config.apiKey,
//         userId,
//         sessionId,
//         userTraits: config.user,
//         startedAt: sessionStartedAt,
//         events: batch,
//         maskedElements: config.dataMasking.blockSelectors,
//         sessionTimeout: config.sessionTimeout,
//       };

//       try {
//         navigator.sendBeacon(
//           `${config.collectorUrl}/sessions`,
//           JSON.stringify(payload),
//         );
//       } catch (error) {
//         console.error("VoidrCollector: Failed to send events", error);
//         events.unshift(...batch);
//       } finally {
//         isSending = false;
//       }
//     },

//     _sendNetworkEvents() {
//       if (networkBuffer.length === 0) return;

//       events.push({
//         type: 5,
//         timestamp: Date.now(),
//         data: {
//           plugin: "network.batch",
//           payload: {
//             requests: networkBuffer.splice(0),
//           },
//         },
//       });
//     },

//     _handleUnload() {
//       this._sendNetworkEvents();
//       this._sendEvents();

//       // Envio síncrono como fallback
//       if (events.length > 0) {
//         const payload = {
//           apiKey: config.apiKey,
//           userId,
//           sessionId,
//           events,
//         };

//         const xhr = new XMLHttpRequest();
//         xhr.open("POST", `${config.collectorUrl}/sessions`, false);
//         xhr.setRequestHeader("Content-Type", "application/json");
//         xhr.send(JSON.stringify(payload));
//       }
//     },
//   };
// })();

// export default VoidrCollector;

// if (typeof window !== "undefined") {
//   window.VoidrCollector = VoidrCollector;
// }
console.log('oi');
