# Build e Deploy da Extensão

## 📦 Preparação para Produção

### 1. Ícones da Extensão

Antes de fazer deploy, você precisa criar os ícones da extensão:

```bash
# Crie os seguintes arquivos na pasta icons/:
chrome-extension/icons/icon-16.png   # 16x16 pixels
chrome-extension/icons/icon-32.png   # 32x32 pixels
chrome-extension/icons/icon-48.png   # 48x48 pixels
chrome-extension/icons/icon-128.png  # 128x128 pixels
```

### 2. Configuração do manifest.json

O arquivo `manifest.json` já está configurado para produção. Certifique-se de:

- Atualizar a versão quando necessário
- Verificar as permissões necessárias
- Confirmar URLs de produção da API

### 3. Minificação (Opcional)

Para otimizar o tamanho da extensão:

```bash
# Instale ferramentas de minificação
npm install -g uglify-js clean-css-cli

# Minifique JavaScript (opcional para desenvolvimento)
uglifyjs content/content.js -o content/content.min.js
uglifyjs popup/popup.js -o popup/popup.min.js
uglifyjs background/background.js -o background/background.min.js

# Minifique CSS
cleancss content/content.css -o content/content.min.css
cleancss popup/popup.css -o popup/popup.min.css
```

## 🚀 Instalação Local

### Para Desenvolvimento

1. Abra Chrome e vá para `chrome://extensions/`
2. Ative "Modo do desenvolvedor"
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `chrome-extension/`

### Para Teste em Produção

1. Comprima a pasta `chrome-extension/` em um arquivo `.zip`
2. Vá para `chrome://extensions/`
3. Ative "Modo do desenvolvedor"
4. Clique em "Carregar extensão compactada"
5. Selecione o arquivo `.zip`

## 📋 Checklist de Deploy

### Antes do Deploy

- [ ] Todos os ícones estão criados e nas dimensões corretas
- [ ] Versão atualizada no `manifest.json`
- [ ] URLs da API apontam para produção
- [ ] Testes realizados em diferentes sites
- [ ] Funcionalidades principais testadas
- [ ] Popup funciona corretamente
- [ ] Widget injeta sem conflitos

### Para Chrome Web Store

- [ ] Conta de desenvolvedor criada ($5 taxa única)
- [ ] Screenshots da extensão preparadas
- [ ] Descrição detalhada escrita
- [ ] Política de privacidade (se necessário)
- [ ] Arquivo `.zip` com no máximo 128MB

## 🔧 Scripts de Build Automático

Você pode adicionar estes scripts ao `package.json` principal:

```json
{
  "scripts": {
    "extension:dev": "echo 'Carregue a pasta chrome-extension no Chrome'",
    "extension:build": "cd chrome-extension && zip -r ../voidr-extension.zip . -x '*.md' '*.git*'",
    "extension:clean": "rm -f voidr-extension.zip"
  }
}
```

Uso:

```bash
# Criar build para produção
npm run extension:build

# Limpar arquivos de build
npm run extension:clean
```

## 🌐 Deploy na Chrome Web Store

### 1. Preparação

```bash
# Criar arquivo ZIP para upload
cd chrome-extension
zip -r ../voidr-extension.zip . -x "*.md" "*.git*" "node_modules/*"
```

### 2. Upload

1. Acesse [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Clique em "Add new item"
3. Upload do arquivo ZIP
4. Preencha informações:
   - Nome: "Voidr Testing Assistant"
   - Descrição: [Use a descrição do README.md]
   - Categoria: "Developer Tools"
   - Screenshots: Capture telas do widget e popup

### 3. Review Process

- Primeira submissão: 1-3 dias
- Atualizações: Algumas horas a 1 dia
- Pode ser rejeitada se não seguir políticas

## 🔒 Considerações de Segurança

### Content Security Policy

O manifest já inclui CSP básica. Para produção, considere:

```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

### Permissões Mínimas

Revise se todas as permissões são necessárias:

- `activeTab`: ✅ Necessária para widget
- `storage`: ✅ Necessária para configurações
- `scripting`: ✅ Necessária para injeção
- `host_permissions`: ✅ Necessária para todos os sites

## 📊 Monitoramento

### Analytics (Futuro)

Considere adicionar analytics para entender uso:

```javascript
// Exemplo de tracking básico
chrome.storage.local.get(['usage_stats'], (result) => {
  const stats = result.usage_stats || { widget_opens: 0 };
  stats.widget_opens++;
  chrome.storage.local.set({ usage_stats: stats });
});
```

### Error Reporting

Implemente logging para debugging em produção:

```javascript
// Enviar erros para serviço de logging
window.addEventListener('error', (e) => {
  console.error('Extension error:', e.error);
  // Enviar para Sentry, LogRocket, etc.
});
```

## 🔄 Atualizações Automáticas

A extensão se atualiza automaticamente quando publicada na Chrome Web Store. Para controlar atualizações:

```json
{
  "update_url": "https://clients2.google.com/service/update2/crx"
}
```

## 📈 Métricas de Sucesso

Monitore estas métricas após deploy:

- Número de instalações
- Avaliações dos usuários
- Relatórios de bugs
- Uso das funcionalidades principais
- Performance em diferentes sites
