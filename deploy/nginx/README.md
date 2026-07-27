# nginx - vhost de produção

`doutorofertas.com.br.conf` (oficial), `doutoroferta.com.br.conf` (aposentado, so 301) e `rotas.conf` (snippet compartilhado) sao um **retrato** do que está rodando em
`/etc/nginx/` na VPS. Está aqui para não se
perder junto com a máquina, e para as decisões ficarem revisáveis.

**Não é aplicado por `npm run deploy`, de propósito.** A VPS também serve
`dashrp.com.br` em produção; sobrescrever config de nginx por automação é como
se derruba um site que não tem nada a ver com este projeto. Para aplicar:

```bash
scp deploy/nginx/doutoroferta.com.br.conf \
    root@168.231.89.180:/etc/nginx/sites-available/doutoroferta.com.br
ssh root@168.231.89.180 'nginx -t && systemctl reload nginx'
ssh root@168.231.89.180 'curl -s -o /dev/null -w "dashrp: %{http_code}\n" https://dashrp.com.br'
```

As linhas marcadas `# managed by Certbot` são escritas pelo certbot na
renovação. Se você editar este arquivo e reaplicar, confira se elas
sobreviveram - sem elas o site sai do ar em HTTPS.

## Duas decisões que não são óbvias no arquivo

**`location ~ ^/([a-z0-9-]+)$`** - serve `/<slug>` sem barra final com 200, em
vez do 301 que o nginx daria pra `/<slug>/`. O fetcher de prévia do WhatsApp
**não segue redirect**: lê a resposta vazia do 301 e o link sai sem card. Como
`/perfumes` (sem barra) é a forma que a pessoa digita, o card se perdia
exatamente ali. É por isso também que o HTML usa caminhos absolutos.

**Sem `add_header Cache-Control` junto de `expires`** - as duas diretivas
juntas emitem *dois* headers `Cache-Control` na mesma resposta. Resposta
malformada: o Discord tolerava, o WhatsApp descartava e o card não aparecia.
