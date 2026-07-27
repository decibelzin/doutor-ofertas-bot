#!/usr/bin/env bash
# Funil da landing, lido direto dos logs do nginx. Roda NA VPS.
#   npm run funil            -> hoje
#   npm run funil -- 7       -> últimos 7 dias
#
# Não há pixel nem cookie: o nginx já registra tudo que é preciso. "Visitantes"
# é IP distinto — não é perfeito (celular trocando de rede conta duas vezes,
# gente atrás do mesmo NAT conta uma), mas é estável o bastante pra comparar
# um dia com o outro, que é o que importa.
# SEM `set -e` de propósito. Num relatório, "não achou nada" é resultado válido,
# e todo `grep` sem resultado devolve 1 — com -e o script morria calado antes do
# cabeçalho, em vez de imprimir zeros. `pipefail` fica de fora pelo mesmo motivo.
set -u

DIAS="${1:-1}"
ACESSOS=/var/log/nginx/doutoroferta-acessos.log
CLIQUES=/var/log/nginx/doutoroferta-cliques.log

# Log rotacionado: junta o .log com os .log.1 recentes.
juntar() { cat "$1" "$1".1 2>/dev/null || true; }

# Datas do período, no formato que o nginx escreve (26/Jul/2026).
datas=$(for i in $(seq 0 $((DIAS - 1))); do date -u -d "-$i day" '+%d/%b/%Y'; done)
filtro=$(echo "$datas" | paste -sd'|')

# Robô não é gente: sem isso o scraper de link infla a contagem de visitas.
ROBOS='bot|crawler|spider|facebookexternalhit|WhatsApp|Discordbot|Twitterbot|curl|wget|HeadlessChrome|Slackbot|TelegramBot'

acessos=$(juntar "$ACESSOS" | grep -E "\[($filtro)" | grep -vEi "$ROBOS" || true)
cliques=$(juntar "$CLIQUES" | grep -E "\[($filtro)" | grep -vEi "$ROBOS" || true)

PAGINA='GET /[a-z0-9-]+/? HTTP'
paginas=$(echo "$acessos"  | grep -cE "$PAGINA")
visitantes=$(echo "$acessos" | grep -E "$PAGINA" | awk '{print $1}' | sort -u | grep -c .)
# navigator.sendBeacon manda POST, nao GET — procurar so por "GET /e" contava
# zero e ainda batia com os curl de teste, que sao GET. Aceita os dois metodos.
CLIQUE='"(GET|POST) /e'
n_cliques=$(echo "$cliques" | grep -cE "$CLIQUE")
cliques_unicos=$(echo "$cliques" | grep -E "$CLIQUE" | awk '{print $1}' | sort -u | grep -c .)

echo
echo "FUNIL — últimos $DIAS dia(s)"
echo "────────────────────────────────────"
printf '  %-24s %s\n' "visitantes (IP único)" "$visitantes"
printf '  %-24s %s\n' "páginas vistas" "$paginas"
printf '  %-24s %s\n' "cliques no botão" "$n_cliques"
printf '  %-24s %s\n' "quem clicou (IP único)" "$cliques_unicos"

if [ "$visitantes" -gt 0 ]; then
  printf '  %-24s %s%%\n' "TAXA DE CLIQUE" \
    "$(awk -v c="$cliques_unicos" -v v="$visitantes" 'BEGIN{printf "%.1f", c/v*100}')"
else
  echo "  (sem visitas no período)"
fi

echo
echo "  De onde vieram:"
echo "$acessos" | grep -E 'GET /[a-z0-9-]+/? HTTP' \
  | awk -F'"' '{print $4}' | sed 's|https\?://||; s|/.*||' \
  | sed 's/^-$/(direto ou app)/; s/^$/(direto ou app)/' \
  | sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'

echo
echo "  Por nicho:"
echo "$cliques" | grep -oE 'n=[a-z0-9-]+' | sort | uniq -c | sort -rn | sed 's/^/    /' \
  || echo "    (nenhum clique ainda)"
echo
