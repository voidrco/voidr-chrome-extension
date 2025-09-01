# Voidr Testing Assistant - Extensão Chrome

Esta é a extensão do Chrome para o Voidr Testing Assistant, que permite planejamento de testes e report de bugs diretamente nas páginas web.

## 🚀 Funcionalidades (PoC)

### Versão Atual (v1.0.0)

- ✅ **Sistema de autenticação completo** com UI dark metálica
- ✅ **Widget flutuante** injetável em qualquer página (apenas para usuários autenticados)
- ✅ **Interface para planejamento de testes** integrada com API
- ✅ **Interface para report de bugs** integrada com API
- ✅ **Captura de screenshots** da página atual
- ✅ **Configurações persistentes** e gerenciamento de token JWT
- ✅ **Popup de controle** da extensão com verificação de autenticação

### Próximas Iterações

- 🔄 **Seleção interativa de elementos** na página com highlight
- 🔄 **Criação automática de casos de teste** baseada em interações
- 🔄 **Captura de screenshots específicos** de elementos selecionados
- 🔄 **Gravação de sessões de teste** com replay automático
- 🔄 **Análise automática de acessibilidade** dos elementos
- 🔄 **Sincronização offline** de dados coletados

## 📁 Estrutura do Projeto

```
chrome-extension/
├── manifest.json          # Configuração da extensão
├── auth/                  # Sistema de autenticação
│   ├── auth.html         # Interface de login
│   ├── auth.css          # Estilos dark metálicos
│   └── auth.js           # Lógica de autenticação
├── background/
│   └── background.js      # Service worker com API integration
├── content/
│   ├── content.js         # Script injetado (com auth check)
│   └── content.css        # Estilos do widget
├── popup/
│   ├── popup.html         # Interface do popup
│   ├── popup.css          # Estilos do popup
│   └── popup.js           # Lógica do popup (com auth)
├── widget/
│   └── widget.js          # Widget standalone
├── icons/
│   ├── create-icons.html  # Gerador de ícones
│   └── README.md          # Instruções para ícones
├── build.md               # Guia de build e deploy
└── README.md              # Este arquivo
```

## 🛠️ Instalação para Desenvolvimento

1. **Clone o repositório** (se ainda não fez):

   ```bash
   git clone [url-do-repositorio]
   cd voidr-platform
   ```

2. **Abra o Chrome** e vá para `chrome://extensions/`

3. **Ative o modo desenvolvedor** (toggle no canto superior direito)

4. **Clique em "Carregar sem compactação"**

5. **Selecione a pasta** `chrome-extension` dentro do projeto

6. **A extensão será instalada** e aparecerá na lista

## 🎯 Como Usar

### 1. First Access - Authentication

1. **Install the extension** following the instructions above
2. **Click the extension icon** in the toolbar
3. **Click "Login"** if not authenticated
4. **Login to the Voidr platform** in the tab that opens (`localhost:3030`)
5. **Return to the extension** - it will automatically detect your authentication

### 2. Via Popup da Extensão (Usuário Autenticado)

1. Clique no ícone da extensão na barra de ferramentas
2. Veja suas informações de usuário no topo
3. Use os botões para:
   - **Abrir Widget**: Mostra/esconde o widget na página atual
   - **Injetar Widget**: Força a injeção do widget
   - **Capturar Tela**: Faz screenshot da página

### 3. Via Widget na Página

1. O widget aparece como um botão flutuante no canto inferior direito
2. Clique para abrir o painel com duas abas:
   - **Planejamento**: Para criar casos de teste (integrado com API)
   - **Bug Report**: Para reportar problemas (integrado com API)

### 4. Configurações

- **Auto-injetar**: Widget aparece automaticamente em novas páginas
- **Tema escuro**: Mantém o visual dark (padrão)
- **Token JWT**: Gerenciado automaticamente com renovação

## 🔧 Desenvolvimento

### Estrutura de Arquivos

- **`manifest.json`**: Define permissões, scripts e configurações da extensão
- **`background/background.js`**: Service worker para comunicação entre componentes
- **`content/content.js`**: Script principal injetado nas páginas
- **`popup/`**: Interface de controle da extensão
- **`widget/widget.js`**: Widget standalone para injeção manual

### Comunicação Entre Componentes

```
Popup ←→ Background ←→ Content Script ←→ Widget
```

- **Popup**: Controla configurações e ações da extensão
- **Background**: Gerencia storage e comunicação
- **Content Script**: Injeta e controla widget nas páginas
- **Widget**: Interface de usuário para testes e bugs

### Próximos Passos de Desenvolvimento

1. **Integração com API**:

   ```javascript
   // Exemplo de integração futura
   const API_BASE = 'https://voidr-service-785568282479.us-central1.run.app';
   ```

2. **Seleção de Elementos**:

   - Implementar highlight de elementos
   - Capturar seletores CSS
   - Gerar casos de teste automaticamente

3. **Captura Avançada**:
   - Screenshots de elementos específicos
   - Gravação de interações
   - Dados de performance

## 🚨 Limitações Atuais

- Interface é mockada (não integrada com API)
- Seleção de elementos não implementada
- Screenshots são básicos (página inteira)
- Não há persistência de dados de testes

## 🔒 Permissões

A extensão solicita as seguintes permissões:

- `activeTab`: Para acessar a aba atual
- `storage`: Para salvar configurações
- `scripting`: Para injetar scripts nas páginas
- `host_permissions`: Para funcionar em todos os sites

## 🐛 Debugging

1. **Popup**: Clique direito no ícone → "Inspecionar popup"
2. **Background**: Vá em `chrome://extensions/` → "Service worker"
3. **Content Script**: F12 na página → Console
4. **Logs**: Todos os componentes fazem log no console

## 📝 Notas de Implementação

- Usa Manifest V3 (mais recente)
- Estilos isolados com z-index máximo
- Comunicação assíncrona entre componentes
- Configurações persistem entre sessões
- Widget responsivo para mobile

## 🎨 Design System

- **Cores**: Gradiente #667eea → #764ba2
- **Tema**: Dark por padrão
- **Tipografia**: System fonts (-apple-system, etc.)
- **Componentes**: Consistentes com plataforma Voidr
