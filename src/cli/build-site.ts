import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { loadLandings, type Landing, type LandingsFile } from '../core/landing';
import { config } from '../config';
import { logger } from '../logger';
import { writeFileAtomic } from '../util/atomic';
import {
  BG, GOLD, GREEN, TEXT, MUTED,
  ajustaCorpo, estimaLargura, logoRedondo, textoSvg,
} from '../site/arte';

/**
 * GERADOR DO SITE - uma página estática por nicho.
 *
 *   npm run build-site
 *
 * Entra: config/landings.json + src/site/landing.template.html
 * Sai:   website/<slug>/index.html   (página)
 *        website/<slug>/og.png       (card 1200x630 do compartilhamento)
 *        website/index.html          (raiz manda pro nicho padrão)
 *
 * styles.css e assets/ ficam na RAIZ de website/ e são compartilhados: quem
 * visita dois nichos baixa o logo uma vez só.
 *
 * O groups.json de cada pasta NÃO é gerado aqui - quem escreve é o bot, a cada
 * SITE_REFRESH_MINUTES (ver src/core/group-status.ts).
 */

/**
 * URL do CSS com impressao digital do conteudo: /styles.css?v=<hash>.
 *
 * O nginx serve o CSS com `expires 1h`, entao sem isso uma correcao de estilo
 * levava ate uma hora pra chegar em quem ja tinha visitado - e a pagina ficava
 * com HTML novo e CSS velho, que e pior que os dois velhos. Com o hash na URL,
 * mudou o arquivo, mudou o endereco, e o cache antigo deixa de ser consultado.
 */
function urlDoCss(): string {
  try {
    const css = fs.readFileSync(path.resolve(config.site.dir, 'styles.css'));
    return `/styles.css?v=${crypto.createHash('sha1').update(css).digest('hex').slice(0, 8)}`;
  } catch {
    return '/styles.css';
  }
}

const TEMPLATE = path.resolve('src/site/landing.template.html');
const TEMPLATE_HUB = path.resolve('src/site/hub.template.html');
const TEMPLATE_PRIVACIDADE = path.resolve('src/site/privacidade.template.html');

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Preenche {{CHAVE}} no template. Falha se sobrar placeholder não resolvido. */
function render(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`Template usa {{${k}}}, que o gerador não preenche.`);
    return vars[k];
  });
  const sobrou = out.match(/\{\{\w+\}\}/);
  if (sobrou) throw new Error(`Placeholder não resolvido no HTML gerado: ${sobrou[0]}`);
  return out;
}

// ── Card 1200x630 ─────────────────────────────────────────────────────────

const W = 1200;
const H = 630;
const CX = 300;          // centro do logo
const LOGO = 300;        // diâmetro do logo no card
const COL_X = 560;       // início da coluna de texto
const COL_W = W - 56 - COL_X;

async function geraOg(landing: Landing, destino: string): Promise<void> {
  const { linhas, destaque = -1, pilula = 'GRUPO GRÁTIS NO WHATSAPP' } = landing.og;
  const apoio = (landing.og.apoio ?? landing.apoio).toUpperCase();

  const corpo = ajustaCorpo(linhas, COL_W, 'condensada', 96, 52);
  const CORPO_APOIO = ajustaCorpo([apoio], COL_W, 'arial', 30, 20);
  const CORPO_PILULA = 34;
  const PILULA_H = 74;
  const LH = Math.round(corpo * 1.02);

  // Alturas em baseline: a última linha do headline NÃO consome uma entrelinha
  // inteira - somar LH por linha empurrava o apoio ~120px pra baixo.
  const DESCIDA = corpo * 0.24;          // descida aproximada dos glifos
  const GAP_APOIO = 30;
  const GAP_PILULA = 30;
  const bloco =
    (linhas.length - 1) * LH + corpo + DESCIDA + GAP_APOIO + CORPO_APOIO + GAP_PILULA + PILULA_H;

  let baseline = Math.round((H - bloco) / 2) + corpo;   // y de <text> é a baseline
  const headline = linhas
    .map((l, i) => {
      const s = textoSvg(l, COL_X, baseline, {
        corpo, cor: i === destaque ? GOLD : TEXT, familia: 'condensada', largura: COL_W,
      });
      if (i < linhas.length - 1) baseline += LH;
      return s;
    })
    .join('\n  ');

  const yApoio = baseline + DESCIDA + GAP_APOIO + CORPO_APOIO;
  const yPilula = yApoio + GAP_PILULA;
  const larguraPilula = Math.min(estimaLargura(pilula, CORPO_PILULA, 'arial') + 64, COL_W);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="brilho">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity=".22"/>
      <stop offset="70%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <circle cx="${CX}" cy="${H / 2}" r="300" fill="url(#brilho)"/>
  <circle cx="${CX}" cy="${H / 2}" r="${LOGO / 2 + 7}" fill="none" stroke="${GOLD}" stroke-width="4"/>
  ${headline}
  ${textoSvg(apoio, COL_X, yApoio, { corpo: CORPO_APOIO, cor: MUTED, familia: 'arial', largura: COL_W, negrito: true })}
  <rect x="${COL_X}" y="${Math.round(yPilula)}" width="${Math.round(larguraPilula)}" height="${PILULA_H}" rx="${PILULA_H / 2}" fill="${GREEN}"/>
  ${textoSvg(pilula, COL_X + larguraPilula / 2, yPilula + PILULA_H / 2 + CORPO_PILULA * 0.36, {
    corpo: CORPO_PILULA, cor: BG, familia: 'arial', largura: larguraPilula - 40, centro: true, negrito: true,
  })}
</svg>`;

  const logo = await logoRedondo(LOGO);

  /* JPEG e não PNG: a arte é fotográfica (o mascote), então o PNG ficava em
     ~190 KB pra render igual. O WhatsApp é conservador com o peso do og:image
     e desiste da prévia em imagens grandes - JPEG entrega o mesmo card por
     volta de 1/3 do tamanho. chromaSubsampling 4:4:4 evita que o texto em
     caixa alta e o dourado fiquem com borda suja, que é o defeito típico do
     JPEG padrão (4:2:0) em cima de tipografia. */
  await sharp(Buffer.from(svg))
    .composite([{ input: logo, left: CX - LOGO / 2, top: Math.round(H / 2 - LOGO / 2) }])
    .jpeg({ quality: 88, progressive: true, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(destino);
}

// ── Geração ───────────────────────────────────────────────────────────────

/**
 * O `fallbackInvite` fica GRAVADO no HTML e é o link que vale nos primeiros
 * instantes, antes do fetch do groups.json - e é o único link se o JS falhar.
 *
 * Ele envelhece calado: basta recriar um grupo no WhatsApp e o convite antigo
 * morre sem nada acusar. Aconteceu de verdade (grupos 1 e 2 recriados), e o
 * sintoma seria uma fatia dos cliques caindo em "convite inválido".
 *
 * Aqui só avisa: o groups.json é dado de runtime e pode legitimamente não
 * existir na máquina que gera o site, então isso não pode falhar o build.
 */
function conferConvite(landing: Landing, dir: string): void {
  const arquivo = path.join(dir, 'groups.json');
  if (!fs.existsSync(arquivo)) return;

  let join: string | null = null;
  try {
    join = (JSON.parse(fs.readFileSync(arquivo, 'utf8')) as { join?: string | null }).join ?? null;
  } catch {
    return;
  }
  if (!join || join === landing.fallbackInvite) return;

  const aviso =
    `fallbackInvite de "${landing.slug}" não bate com o groups.json.\n` +
    `      no config: ${landing.fallbackInvite}\n` +
    `      no grupo:  ${join}\n` +
    `      Se o grupo foi recriado, o convite do config está morto - atualize config/landings.json.`;
  logger.warn({ slug: landing.slug, config: landing.fallbackInvite, atual: join }, `[site] ${aviso}`);
  console.warn(`\n⚠  ${aviso}\n`);
}

async function geraLanding(cfg: LandingsFile, landing: Landing, tpl: string, raiz: string): Promise<void> {
  const dir = path.join(raiz, landing.slug);
  fs.mkdirSync(dir, { recursive: true });

  const pageUrl = `${cfg.baseUrl}/${landing.slug}/`;
  const html = render(tpl, {
    TITLE: escapeHtml(landing.title),
    DESCRIPTION: escapeHtml(landing.description),
    PAGE_URL: pageUrl,
    OG_TITLE: escapeHtml(landing.og.title),
    OG_DESCRIPTION: escapeHtml(landing.og.description),
    OG_IMAGE: `${cfg.baseUrl}/${landing.slug}/og.jpg`,
    HEADLINE: escapeHtml(landing.headline),
    HEADLINE_HIGHLIGHT: escapeHtml(landing.highlight),
    APOIO: escapeHtml(landing.apoio),
    MARCAS: escapeHtml(landing.marcas.join(' · ')),
    BLOCO_TURMA: landing.turma.trim()
      ? `    <p class="vagas">${escapeHtml(landing.turma)}</p>`
      : '',
    NOTA: escapeHtml(landing.nota),
    RODAPE: escapeHtml(landing.rodape),
    FALLBACK_INVITE: escapeHtml(landing.fallbackInvite),
    SLUG: landing.slug,
    SCHEMA: jsonLd(cfg, landing, pageUrl),
    CSS_URL: urlDoCss(),
  });

  const aviso = `<!-- GERADO por \`npm run build-site\`. NÃO edite à mão.
     Conteúdo: config/landings.json · Estrutura: src/site/landing.template.html -->\n`;
  writeFileAtomic(path.join(dir, 'index.html'), html.replace(/^<!doctype html>\n/i, `<!doctype html>\n${aviso}`));

  await geraOg(landing, path.join(dir, 'og.jpg'));
  // Card antigo em PNG: sai do caminho pra ninguem servir arte velha.
  fs.rmSync(path.join(dir, 'og.png'), { force: true });

  conferConvite(landing, dir);

  logger.info({ slug: landing.slug, url: pageUrl }, '[site] Landing gerada.');
}

/**
 * JSON-LD de Organization, igual em todas as páginas e com o MESMO `@id`.
 *
 * Repetir de propósito: o `@id` faz o Google fundir as ocorrências numa
 * entidade só, então cada página nova reforça a associação "Doutor Ofertas =
 * este domínio" em vez de criar uma marca nova. É o sinal mais direto pra
 * busca por nome, e não acrescenta uma palavra visível na tela.
 */
function jsonLd(cfg: LandingsFile, landing: Landing, pageUrl: string): string {
  const org = `${cfg.baseUrl}/#organizacao`;
  const dados = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: 'Doutor Ofertas',
        url: `${cfg.baseUrl}/`,
        logo: `${cfg.baseUrl}/assets/logo.jpg`,
        description: landing.description,
      },
      {
        '@type': 'WebPage',
        '@id': pageUrl,
        url: pageUrl,
        name: landing.title,
        description: landing.description,
        inLanguage: 'pt-BR',
        isPartOf: { '@id': org },
        publisher: { '@id': org },
      },
    ],
  };
  // </script> dentro de JSON quebraria o bloco; escapar a barra é o padrão.
  return `<script type="application/ld+json">
${JSON.stringify(dados, null, 2).replace(/</g, '\u003c')}
</script>`;
}

/**
 * sitemap.xml a partir das landings — some a necessidade de lembrar de
 * atualizar quando entrar um nicho novo.
 *
 * O Google acha página seguindo link de outro site. Como ninguém linka pra cá
 * ainda, o sitemap é o substituto dos links que não existem.
 */
function geraSitemap(cfg: LandingsFile, raiz: string, hoje: string): void {
  // A raiz só entra quando é hub de verdade; como redirect `noindex` ela não
  // deve ser oferecida pra indexação.
  const alvos = [
    ...(cfg.hub ? [''] : []),
    ...cfg.landings.map((l) => `${l.slug}/`),
  ];
  const urls = alvos
    .map((caminho) => `  <url>
    <loc>${cfg.baseUrl}/${caminho}</loc>
    <lastmod>${hoje}</lastmod>
  </url>`)
    .join('\n');
  writeFileAtomic(
    path.join(raiz, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
  );
  logger.info({ urls: alvos.length }, '[site] sitemap.xml gerado.');
}

/** robots.txt: libera tudo e diz onde está o sitemap. */
function geraRobots(cfg: LandingsFile, raiz: string): void {
  writeFileAtomic(
    path.join(raiz, 'robots.txt'),
    [
      '# Gerado por `npm run build-site`. Nao edite a mao.',
      'User-agent: *',
      'Allow: /',
      '',
      '# /e e a rota do contador de cliques (responde 204, nao e conteudo).',
      'Disallow: /e',
      '',
      `Sitemap: ${cfg.baseUrl}/sitemap.xml`,
      '',
    ].join('\n')
  );
  logger.info('[site] robots.txt gerado.');
}

/**
 * A RAIZ é o hub: uma página indexável que lista os nichos.
 *
 * Antes ela era `noindex` + redirect, e isso custava justamente a busca por
 * marca: a URL que carrega o nome "Doutor Ofertas" não existia pro Google.
 * Com vários nichos, pior ainda - quem procurasse a marca cairia numa página
 * que só sabe falar de um deles.
 *
 * Ela NÃO é destino de anúncio. Campanha aponta direto pra /<nicho>, que é a
 * landing de conversão; aqui cai quem digita o domínio ou vem da busca. Por
 * isso ela pode ter um clique a mais sem custar conversão de campanha.
 *
 * Sem o bloco `hub` no config, cai no redirect antigo.
 */
/**
 * Canal pra exercer direitos da LGPD. Enquanto não houver e-mail público, o
 * grupo é o canal que EXISTE de verdade - prometer um endereço que ninguém lê
 * seria pior que não prometer nada.
 */
const CONTATO_LGPD = 'o administrador em qualquer um dos nossos grupos de WhatsApp';

/**
 * Política de privacidade, servida INTEIRA em dois caminhos: `/privacy`
 * (canônico, porque foi o endereço registrado no Pinterest) e `/privacidade`.
 *
 * Os dois entregam o conteúdo completo em vez de um redirecionar pro outro:
 * verificador automático de terceiro nem sempre segue redirect, e a URL fica
 * gravada no cadastro deles pra revalidação futura - uma quebra apareceria
 * meses depois, longe daqui. O `canonical` aponta pro mesmo lugar nos dois,
 * então o buscador trata como uma página só.
 */
function geraPrivacidade(cfg: LandingsFile, raiz: string, tpl: string): void {
  const canonica = `${cfg.baseUrl}/privacy/`;
  const hoje = new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: config.timezone,
  });

  const html = render(tpl, {
    TITLE: 'Política de Privacidade - Doutor Ofertas',
    PAGE_URL: canonica,
    CSS_URL: urlDoCss(),
    ATUALIZADO: hoje,
    CONTATO: CONTATO_LGPD,
  }).replace(
    /^<!doctype html>/i,
    '<!doctype html>\n<!-- GERADO por `npm run build-site`. NÃO edite à mão. -->'
  );

  for (const nome of ['privacy', 'privacidade']) {
    const dir = path.join(raiz, nome);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, 'index.html'), html);
  }

  logger.info({ canonica, tambem: `${cfg.baseUrl}/privacidade/` }, '[site] Política de privacidade gerada.');
}

function geraHub(cfg: LandingsFile, raiz: string, tplHub: string): void {
  if (!cfg.hub) {
    const destino = `./${cfg.default}/`;
    writeFileAtomic(path.join(raiz, 'index.html'), `<!doctype html>
<!-- GERADO por \`npm run build-site\`. NÃO edite à mão. -->
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Doutor Ofertas</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${cfg.baseUrl}/${cfg.default}/">
<meta http-equiv="refresh" content="0; url=${destino}">
<script>location.replace(${JSON.stringify(destino)});</script>
</head>
<body style="background:${BG};color:${TEXT};font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem">
<p><a href="${destino}" style="color:${GOLD}">Ir para as ofertas</a></p>
</body>
</html>
`);
    logger.info({ destino }, '[site] Sem bloco `hub`: raiz segue como redirect.');
    return;
  }

  const pageUrl = `${cfg.baseUrl}/`;
  // <a> de verdade: é seguindo estes links que o crawler acha as páginas de
  // nicho a partir da raiz.
  const nichos = cfg.landings
    .map(
      (l) => `    <a class="nicho" href="/${l.slug}">
      <span class="nicho-nome">${escapeHtml(l.headline)} <b>${escapeHtml(l.highlight)}</b></span>
      <span class="nicho-seta" aria-hidden="true">›</span>
    </a>`
    )
    .join('\n');

  const org = `${cfg.baseUrl}/#organizacao`;
  const schema = `<script type="application/ld+json">\n${JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': org,
          name: 'Doutor Ofertas',
          url: pageUrl,
          logo: `${cfg.baseUrl}/assets/logo.jpg`,
          description: cfg.hub.description,
        },
        {
          '@type': 'WebSite',
          '@id': `${pageUrl}#site`,
          url: pageUrl,
          name: 'Doutor Ofertas',
          inLanguage: 'pt-BR',
          publisher: { '@id': org },
        },
      ],
    },
    null,
    2
  ).replace(/</g, '\\u003c')}\n</script>`;

  const html = render(tplHub, {
    TITLE: escapeHtml(cfg.hub.title),
    DESCRIPTION: escapeHtml(cfg.hub.description),
    H1: escapeHtml(cfg.hub.h1),
    APOIO: escapeHtml(cfg.hub.apoio),
    RODAPE: escapeHtml(cfg.hub.rodape),
    PAGE_URL: pageUrl,
    // A raiz empresta o card do nicho em destaque: uma arte a menos pra manter.
    OG_IMAGE: `${cfg.baseUrl}/${cfg.default}/og.jpg`,
    SCHEMA: schema,
    NICHOS: nichos,
    CSS_URL: urlDoCss(),
  });

  const aviso = `<!-- GERADO por \`npm run build-site\`. NÃO edite à mão.
     Conteúdo: bloco "hub" em config/landings.json · Estrutura: src/site/hub.template.html -->\n`;
  writeFileAtomic(
    path.join(raiz, 'index.html'),
    html.replace(/^<!doctype html>\n/i, `<!doctype html>\n${aviso}`)
  );
  logger.info({ nichos: cfg.landings.length }, '[site] Hub gerado na raiz.');
}

async function main(): Promise<void> {
  const cfg = loadLandings();
  if (!cfg) throw new Error('config/landings.json não encontrado - nada a gerar.');

  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const raiz = path.resolve(config.site.dir);
  fs.mkdirSync(raiz, { recursive: true });

  for (const landing of cfg.landings) await geraLanding(cfg, landing, tpl, raiz);
  geraHub(cfg, raiz, fs.readFileSync(TEMPLATE_HUB, 'utf8'));
  geraPrivacidade(cfg, raiz, fs.readFileSync(TEMPLATE_PRIVACIDADE, 'utf8'));
  geraSitemap(cfg, raiz, new Date().toISOString().slice(0, 10));
  geraRobots(cfg, raiz);

  console.log(`\n✓ ${cfg.landings.length} landing(s) em ${raiz}`);
  for (const l of cfg.landings) console.log(`   ${cfg.baseUrl}/${l.slug}/`);
  console.log(`   raiz → /${cfg.default}/\n`);
}

main().catch((err: unknown) => {
  logger.error({ err: (err as Error).message }, '[site] Falha ao gerar.');
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exit(1);
});
