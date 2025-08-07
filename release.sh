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

# Garante que a branch local está atualizada com a master remota
git checkout master
git pull origin master

# Executa o npm version, que irá:
# 1. Aumentar a versão no package.json
# 2. Criar um commit com a mensagem "vX.Y.Z"
# 3. Criar uma tag git vX.Y.Z
VERSION=$(npm version $1)

echo "Versão atualizada para ${VERSION}"

git add package.json package-lock.json
git commit -m "chore(release): ${VERSION}"
git tag ${VERSION}

# Envia o commit e a tag para o repositório remoto
git push origin master --tags

echo "✅ Release ${VERSION} enviada com sucesso para o GitHub."
echo "O Google Cloud Build irá iniciar o deploy em breve."
