// Widget standalone para injeção direta em páginas
// Este arquivo pode ser usado independentemente do content script

console.log('Voidr Widget standalone carregado');

// Verifica se já existe um widget na página
if (document.getElementById('voidr-testing-widget')) {
  console.log('Widget já existe na página');
} else {
  // Cria e injeta o widget
  createStandaloneWidget();
}

function createStandaloneWidget() {
  // Cria container do widget
  const widgetContainer = document.createElement('div');
  widgetContainer.id = 'voidr-testing-widget-standalone';
  widgetContainer.innerHTML = `
    <style>
      /* Estilos inline para garantir isolamento */
      #voidr-testing-widget-standalone {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif !important;
        pointer-events: none !important;
      }
      
      #voidr-testing-widget-standalone * {
        box-sizing: border-box !important;
        pointer-events: auto !important;
      }
      
      .voidr-standalone-floating-btn {
        position: fixed !important;
        bottom: 20px !important;
        right: 20px !important;
        width: 56px !important;
        height: 56px !important;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        border-radius: 50% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15) !important;
        transition: all 0.3s ease !important;
        color: white !important;
        z-index: 2147483647 !important;
        border: none !important;
      }
      
      .voidr-standalone-floating-btn:hover {
        transform: scale(1.1) !important;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2) !important;
      }
      
      .voidr-standalone-panel {
        position: fixed !important;
        bottom: 90px !important;
        right: 20px !important;
        width: 380px !important;
        max-height: 600px !important;
        background: #1a1a1a !important;
        border: 1px solid #333 !important;
        border-radius: 12px !important;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3) !important;
        overflow: hidden !important;
        transition: all 0.3s ease !important;
        z-index: 2147483646 !important;
        display: none !important;
      }
      
      .voidr-standalone-panel.visible {
        display: block !important;
      }
      
      .voidr-standalone-header {
        background: #2a2a2a !important;
        padding: 16px 20px !important;
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        border-bottom: 1px solid #333 !important;
      }
      
      .voidr-standalone-header h3 {
        margin: 0 !important;
        font-size: 16px !important;
        font-weight: 600 !important;
        color: #ffffff !important;
      }
      
      .voidr-standalone-close {
        background: none !important;
        border: none !important;
        color: #888 !important;
        font-size: 24px !important;
        cursor: pointer !important;
        padding: 0 !important;
        width: 24px !important;
        height: 24px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 4px !important;
        transition: all 0.2s ease !important;
      }
      
      .voidr-standalone-close:hover {
        background: #333 !important;
        color: #fff !important;
      }
      
      .voidr-standalone-content {
        padding: 20px !important;
        color: #ccc !important;
        max-height: 500px !important;
        overflow-y: auto !important;
      }
      
      .voidr-standalone-message {
        text-align: center !important;
        padding: 40px 20px !important;
      }
      
      .voidr-standalone-message h4 {
        color: #667eea !important;
        margin-bottom: 12px !important;
        font-size: 18px !important;
      }
      
      .voidr-standalone-message p {
        color: #888 !important;
        line-height: 1.5 !important;
        margin-bottom: 20px !important;
      }
      
      .voidr-standalone-button {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        color: white !important;
        border: none !important;
        padding: 10px 20px !important;
        border-radius: 6px !important;
        cursor: pointer !important;
        font-size: 14px !important;
        font-weight: 500 !important;
        transition: all 0.2s ease !important;
      }
      
      .voidr-standalone-button:hover {
        transform: translateY(-1px) !important;
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3) !important;
      }
      
      @media (max-width: 480px) {
        .voidr-standalone-panel {
          right: 10px !important;
          left: 10px !important;
          width: auto !important;
          bottom: 80px !important;
        }
        
        .voidr-standalone-floating-btn {
          right: 15px !important;
          bottom: 15px !important;
        }
      }
    </style>
    
    <button class="voidr-standalone-floating-btn" onclick="toggleStandaloneWidget()">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 12L11 14L15 10M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    
    <div class="voidr-standalone-panel" id="voidr-standalone-panel">
      <div class="voidr-standalone-header">
        <h3>Voidr Testing Assistant</h3>
        <button class="voidr-standalone-close" onclick="hideStandaloneWidget()">×</button>
      </div>
      <div class="voidr-standalone-content">
        <div class="voidr-standalone-message">
          <h4>🚀 Voidr Extension PoC</h4>
          <p>This is an initial version of the extension to demonstrate widget injection on web pages.</p>
          <p><strong>Next steps:</strong></p>
          <ul style="text-align: left; margin: 16px 0; padding-left: 20px;">
            <li>Integration with Voidr API</li>
            <li>Interactive element selection</li>
            <li>Test case creation</li>
            <li>Bug reporting system</li>
            <li>Screenshot capture</li>
          </ul>
          <button class="voidr-standalone-button" onclick="showExtensionInfo()">
            View Page Information
          </button>
        </div>
      </div>
    </div>
  `;

  // Adiciona ao DOM
  document.body.appendChild(widgetContainer);

  // Adiciona event listeners globais
  setupStandaloneListeners();

  console.log('Widget standalone criado com sucesso');
}

function setupStandaloneListeners() {
  // Fechar widget ao clicar fora
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('voidr-standalone-panel');
    const widget = document.getElementById('voidr-testing-widget-standalone');

    if (panel && panel.classList.contains('visible') && widget && !widget.contains(e.target)) {
      hideStandaloneWidget();
    }
  });

  // Prevenir propagação de cliques dentro do widget
  const widget = document.getElementById('voidr-testing-widget-standalone');
  if (widget) {
    widget.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }
}

// Funções globais para controle do widget
window.toggleStandaloneWidget = function () {
  const panel = document.getElementById('voidr-standalone-panel');
  if (panel) {
    if (panel.classList.contains('visible')) {
      hideStandaloneWidget();
    } else {
      showStandaloneWidget();
    }
  }
};

window.showStandaloneWidget = function () {
  const panel = document.getElementById('voidr-standalone-panel');
  if (panel) {
    panel.classList.add('visible');
  }
};

window.hideStandaloneWidget = function () {
  const panel = document.getElementById('voidr-standalone-panel');
  if (panel) {
    panel.classList.remove('visible');
  }
};

window.showExtensionInfo = function () {
  const info = {
    url: window.location.href,
    title: document.title,
    domain: window.location.hostname,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    elements: {
      total: document.querySelectorAll('*').length,
      forms: document.querySelectorAll('form').length,
      buttons: document.querySelectorAll('button').length,
      links: document.querySelectorAll('a').length,
      images: document.querySelectorAll('img').length,
    },
  };

  console.log('Informações da página:', info);
  alert(`Page Information:

URL: ${info.url}
Title: ${info.title}
Domain: ${info.domain}
Viewport: ${info.viewport.width}x${info.viewport.height}

Elements found:
• Total: ${info.elements.total}
• Forms: ${info.elements.forms}
• Buttons: ${info.elements.buttons}
• Links: ${info.elements.links}
• Images: ${info.elements.images}

See console for more details.`);
};
