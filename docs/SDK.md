# VoidrCollector SDK - Documentação

## Instalação

Adicione o script no `<head>` da sua página:

```html
<script type="text/javascript" src="https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js"></script>
```

---

## Inicialização

```javascript
VoidrCollector.init(options);
```

---

## Parâmetros de Configuração

### Parâmetros Obrigatórios

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `apiKey` | `string` | Chave de API fornecida pela plataforma Voidr. Necessária para autenticar as requisições. |
| `user` | `object` | Objeto contendo informações do usuário atual. |
| `user.id` | `string` | Identificador único do usuário. Obrigatório para associar sessões ao usuário. |

---

### Parâmetros Opcionais

#### Identificação do Usuário

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `user.email` | `string` | `undefined` | Email do usuário. Facilita a busca de sessões na plataforma. |
| `user.name` | `string` | `undefined` | Nome do usuário para exibição na plataforma. |

---

#### Configuração do Ambiente

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `collectorUrl` | `string` | `'https://collector.voidr.co'` | URL do servidor collector. **Obrigatório para instalações self-hosted.** |
| `applicationId` | `string` | `null` | Identificador da aplicação. Útil para organizações com múltiplas aplicações. |
| `environment` | `string` | `null` | Ambiente de execução (ex: `"production"`, `"staging"`, `"development"`). |

---

#### Controle de Gravação

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `samplingRate` | `number` | `0.1` | Taxa de amostragem de sessões. Valor entre `0` e `1` representando a porcentagem de sessões a serem gravadas. Ex: `0.1` = 10%, `1` = 100%. |
| `sessionTimeout` | `number` | `30` | Tempo de inatividade (em minutos) após o qual uma nova sessão é criada. |
| `skipRecording` | `boolean` | `false` | Quando `true`, desativa completamente a gravação. Útil para ambientes de teste ou automação. |
| `system` | `boolean` | `false` | Indica se a execução é em contexto de sistema (não é um usuário real navegando). |

---

#### Captura de Dados

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `networkCapture` | `boolean` | `true` | Captura requisições de rede (Fetch e XMLHttpRequest). Inclui URL, método, status, duração e resposta. |
| `captureConsole` | `boolean` | `true` | Captura logs do console (`log`, `warn`, `error`, `info`). |
| `inlineFonts` | `boolean` | `false` | Faz inline de fontes no snapshot inicial para melhorar a fidelidade do replay. Ative apenas quando necessário. |
| `inlineStylesheets` | `boolean` | `false` | Faz inline de folhas de estilo cross-origin ilegíveis para melhorar a fidelidade do replay. Ative apenas quando necessário. |

Desde a versão 1.17.1, `inlineFonts` e `inlineStylesheets` são opt-in para não atrasar a inicialização em sites com muitos assets. Quando habilitadas, as duas operações compartilham um prazo de 1,5 segundo, possuem limites de quantidade e bytes e são canceladas ao pausar ou encerrar a sessão.

---

#### Privacidade e Mascaramento de Dados

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `dataMasking` | `object` | `{}` | Configurações de ofuscação de dados sensíveis. |
| `dataMasking.text` | `boolean` | `false` | Quando `true`, mascara todo o texto visível na página. |
| `dataMasking.inputs` | `boolean` | `false` | Quando `true`, mascara o conteúdo de todos os campos de input. |
| `dataMasking.blockSelectors` | `string[]` | `['[data-sensitivity="block"]']` | Array de seletores CSS para elementos que devem ser completamente bloqueados da gravação. |

---

#### Metadados

| Parâmetro | Tipo | Default | Descrição |
|-----------|------|---------|-----------|
| `meta` | `object` | `null` | Objeto com metadados customizados que serão associados à sessão. Útil para adicionar contexto de negócio. |

---

## Exemplos de Uso

### Configuração Mínima

```javascript
VoidrCollector.init({
  apiKey: "sua-api-key",
  user: {
    id: "user-123"
  }
});
```

### Configuração para Self-Hosted

```javascript
VoidrCollector.init({
  apiKey: "sua-api-key",
  collectorUrl: "https://seu-collector.exemplo.com",
  user: {
    id: "user-123",
    email: "usuario@exemplo.com"
  }
});
```

### Configuração Completa

```javascript
VoidrCollector.init({
  // Autenticação
  apiKey: "sua-api-key",
  
  // Self-hosted
  collectorUrl: "https://seu-collector.exemplo.com",
  
  // Identificação
  applicationId: "app-dashboard",
  environment: "production",
  
  // Usuário
  user: {
    id: "user-123",
    email: "usuario@exemplo.com",
    name: "João Silva"
  },
  
  // Controle de gravação
  samplingRate: 0.25,      // Gravar 25% das sessões
  sessionTimeout: 60,       // Nova sessão após 60 min de inatividade
  skipRecording: false,
  system: false,
  
  // Captura
  networkCapture: true,
  captureConsole: true,
  
  // Privacidade
  dataMasking: {
    text: false,
    inputs: true,           // Mascarar todos os inputs
    blockSelectors: [
      '[data-sensitivity="block"]',
      '.dados-sensiveis',
      '#cartao-credito'
    ]
  },
  
  // Metadados customizados
  meta: {
    tenant: "empresa-abc",
    plano: "enterprise",
    versao: "2.5.0"
  }
});
```

---

## Métodos Adicionais

### `VoidrCollector.identify(id, traits)`

Atualiza a identificação do usuário após a inicialização.

```javascript
VoidrCollector.identify("novo-user-id", {
  email: "novo@email.com",
  name: "Nome Atualizado"
});
```

### `VoidrCollector.updateConfig(updates)`

Atualiza configurações em tempo real.

```javascript
VoidrCollector.updateConfig({
  samplingRate: 0.5
});
```

### `VoidrCollector.endSession()`

Força o encerramento da sessão atual.

```javascript
VoidrCollector.endSession();
```

### `VoidrCollector.getSessionId()`

Retorna o ID da sessão atual.

```javascript
const sessionId = VoidrCollector.getSessionId();
console.log(sessionId); // "1705678901234"
```

---

## Mascaramento de Dados via HTML

Além da configuração via JavaScript, você pode marcar elementos diretamente no HTML:

```html
<!-- Este elemento será bloqueado da gravação -->
<div data-sensitivity="block">
  Conteúdo sensível que não será gravado
</div>
```

---

## Detecção Automática de Automação

O VoidrCollector detecta automaticamente ambientes de automação (Playwright, Selenium, Puppeteer, etc.) e **pula a gravação** para evitar poluir os dados com execuções de testes automatizados.

Ambientes detectados:

- `navigator.webdriver === true`
- `window.playwright`
- `window.__playwright`
- `window.__puppeteer`
- PhantomJS

---

## Snippet para Console (Debug/Teste)

Para testar rapidamente o collector em qualquer página via DevTools Console:

```javascript
(function() {
  const script = document.createElement('script');
  script.src = 'https://cdn.voidr.co/voidr-collector/default/latest/recorder.min.js';
  script.onload = function() {
    VoidrCollector.init({
      apiKey: "SUA_API_KEY",
      collectorUrl: "https://seu-collector.exemplo.com", // Remova para usar SaaS
      user: {
        id: "test-user",
        email: "test@exemplo.com"
      },
      samplingRate: 1 // 100% para testes
    });
    console.log('✅ VoidrCollector initialized!');
  };
  document.head.appendChild(script);
})();
```

---

## Notas Técnicas

- **Versão atual do SDK:** 1.17.1
- **Checkout do rrweb:** Executado a cada 120 segundos ou a cada 1000 eventos
- **Envio de eventos:** Em lotes a cada 7 segundos
- **Lote mínimo:** 10 eventos são necessários antes do envio
- **Armazenamento local:** Utiliza `sessionStorage` para persistir JWT, session ID e user ID
