#!/bin/bash
set -e

# Verifica se um argumento foi passado (patch, minor, or major)
if [ -z "$1" ]; then
  echo "Uso: ./release.sh [patch|minor|major]"
  exit 1
fi

# Verifica se o argumento é válido
if [ "$1" != "patch" ] && [ "$1" != "minor" ] && [ "$1" != "major" ]; then
  echo "Argumento inválido. Use: patch, minor, ou major."
  exit 1
fi

# Garante que a branch local está limpa e atualizada
git checkout master
git pull origin master

# Se o `git status` não estiver limpo, o npm version falhará.
# Adicionamos um check para dar uma mensagem mais clara.
if ! git diff --quiet; then
    echo "Erro: O diretório de trabalho do Git não está limpo."
    echo "Faça o commit ou descarte suas alterações antes de criar uma release."
    git status -s # Mostra os arquivos modificados
    exit 1
fi

# Executa o npm version, que irá:
# 1. Aumentar a versão no package.json
# 2. Criar um commit com a mensagem "vX.Y.Z"
# 3. Criar uma tag git vX.Y.Z
VERSION=$(npm version $1)

echo "Versão atualizada para ${VERSION}"

# Envia o commit e a tag para o repositório remoto.
# O `npm version` já criou o commit e a tag, só precisamos enviar.
git push origin master --tags

echo "✅ Release ${VERSION} enviada com sucesso para o GitHub."
echo "O Google Cloud Build irá iniciar o deploy em breve."
