#!/usr/bin/env bash
# Deploy na VPS. Roda NA VPS — o atalho local é `npm run deploy`.
#
# O nginx serve direto de <repo>/website, então atualizar a landing é só o
# `git pull`: as páginas geradas por `npm run build-site` estão commitadas.
#
# Por que NÃO rodamos build-site aqui: a arte do og.png é montada pedindo as
# fontes Impact/Arial, que não existem num Ubuntu limpo. Gerar na VPS produziria
# um card diferente do que foi validado. Gere no Windows e commite.
set -euo pipefail

REPO=/srv/doutor-ofertas-bot
SERVICO=doutor-ofertas

cd "$REPO"

antes_lock=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo vazio)
antes_src=$(git rev-parse HEAD:src 2>/dev/null || echo vazio)
antes_head=$(git rev-parse HEAD)

echo "→ git pull"
git pull --ff-only

if [ "$(git rev-parse HEAD)" = "$antes_head" ]; then
  echo "→ nada novo. Serviço segue como está."
  systemctl is-active "$SERVICO"
  exit 0
fi

# Só reinstala se a árvore de dependências mudou de verdade.
if [ "$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo vazio)" != "$antes_lock" ]; then
  echo "→ package-lock mudou: npm ci"
  npm ci --no-audit --no-fund
fi

# Só recompila e reinicia se o código do bot mudou. Mudança só de landing não
# derruba a conexão do WhatsApp — reconectar é o momento de maior risco.
if [ "$(git rev-parse HEAD:src 2>/dev/null || echo vazio)" != "$antes_src" ]; then
  echo "→ src mudou: build + restart"
  npm run build
  systemctl restart "$SERVICO"
else
  echo "→ src intacto: landing atualizada sem tocar no bot"
fi

# O nginx serve por caminho: www-data precisa ATRAVESSAR as pastas (755) e LER
# os arquivos (644). Nao usar `chmod -R 755`: isso marca arquivo como
# executavel, o git rastreia esse bit, e cada deploy passava a criar mudancas
# locais que travavam o `git pull` seguinte com "local changes would be
# overwritten".
find "$REPO/website" -type d -exec chmod 755 {} +
find "$REPO/website" -type f -exec chmod 644 {} +

echo
echo "→ conferindo"
printf '   servico: %s\n' "$(systemctl is-active "$SERVICO")"
for p in /perfumes/ /perfumes/og.jpg /styles.css /perfumes/groups.json; do
  printf '   %s  <- %s\n' \
    "$(curl -s -o /dev/null -w '%{http_code}' --resolve doutoroferta.com.br:443:127.0.0.1 --max-time 10 "https://doutoroferta.com.br$p")" "$p"
done
printf '   dashrp (nao pode ter quebrado): %s\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://dashrp.com.br)"
echo
git log --oneline -1
