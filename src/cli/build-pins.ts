import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { loadNiches } from '../core/niches';
import { isBrandSafe, marcasDoNicho } from '../core/quality';
import { collectNicheDeals } from '../core/selector';
import { fetchDealImage } from '../whatsapp/sender';
import { resolvePreset } from '../format/title';
import { formatPrice } from '../format/whatsapp';
import { urlDaLanding } from '../core/landing';
import { dadosDoPin, geraPin } from '../site/pin';

/**
 * GERADOR DE PINS DO PINTEREST.
 *
 *   npm run build-pins          -> 12 pins do nicho de perfume
 *   npm run build-pins -- 20    -> 20 pins
 *
 * Sai em `pins/`: as artes (pin-01.jpg...) e um `pins.md` com título,
 * descrição e link de cada uma, prontos pra colar na hora de publicar.
 *
 * Por que NÃO publica sozinho: publicar exige conta e app aprovado no
 * Pinterest, que é coisa que só o dono da conta faz. Isto aqui resolve a parte
 * cara (a arte e o texto, em lote) e deixa o passo manual em segundos por pin.
 *
 * ⚠️ Roda no WINDOWS. A arte usa Anton/Impact e Arial; num Ubuntu limpo o
 * texto cai pra fonte de fallback e o pin sai diferente do validado - mesmo
 * motivo pelo qual o deploy não gera o og.jpg na VPS.
 */

const DESTINO = path.resolve('pins');

/** Link da landing marcado como Pinterest - é o que separa esse tráfego no funil. */
function linkDoPin(nicheName: string): string {
  const url = urlDaLanding(nicheName, 'pin');
  if (!url) {
    throw new Error(
      'Não achei a landing deste nicho em config/landings.json - sem link, o pin não tem pra onde mandar.'
    );
  }
  return url;
}

/** Título do pin: até 100 caracteres, com o que a pessoa realmente busca. */
function tituloPin(nome: string, preco: number, desconto?: number): string {
  const off = desconto ? ` (${desconto}% OFF)` : '';
  return `${nome} por R$ ${formatPrice(preco)}${off}`.slice(0, 100);
}

/** Descrição do pin: contexto + notas + convite. O link vai no campo próprio. */
function descricaoPin(
  nome: string,
  preco: number,
  precoDe: number | undefined,
  notas: string[] | undefined
): string {
  const partes = [
    precoDe
      ? `${nome} saiu de R$ ${formatPrice(precoDe)} para R$ ${formatPrice(preco)} no Mercado Livre.`
      : `${nome} por R$ ${formatPrice(preco)} no Mercado Livre.`,
  ];
  if (notas?.length) partes.push(`Notas: ${notas.join(', ')}.`);
  partes.push(
    'Perfume árabe e importado com desconto todo dia no nosso grupo do WhatsApp. Entrar é grátis.'
  );
  return partes.join(' ').slice(0, 500);
}

async function main(): Promise<void> {
  const quantidade = Number(process.argv[2] ?? 12);
  if (!Number.isFinite(quantidade) || quantidade < 1) {
    console.error(`\n✗ quantidade tem que ser um inteiro >= 1 (recebi: ${process.argv[2]})\n`);
    process.exit(1);
  }

  const niches = loadNiches();
  const niche = niches.find((n) => /perfum|fragr/i.test(n.name)) ?? niches[0];
  if (!niche) {
    console.error('\n✗ Nenhum nicho configurado em config/niches.json.\n');
    process.exit(1);
  }

  const link = linkDoPin(niche.name);
  const dominio = new URL(link).hostname.replace(/^www\./, '');

  logger.info({ niche: niche.name, quantidade }, '[pins] Coletando ofertas.');
  const brutas = await collectNicheDeals(niche);
  if (brutas.length === 0) {
    console.error('\n✗ Nenhuma oferta voltou. Cookie do hub do ML pode ter expirado.\n');
    process.exit(1);
  }

  /* Gate de PROCEDÊNCIA, mais duro que o do WhatsApp. O pool cru traz
     "perfume de feromônios" de marca no-name; no grupo o post some no
     histórico, no Pinterest o pin fica indexado com a nossa marca em cima. */
  const marcas = marcasDoNicho(niche.ml?.searchTerms);
  const deals = brutas.filter((d) => isBrandSafe(d, marcas));
  const cortadas = brutas.length - deals.length;
  if (cortadas > 0) {
    logger.info(
      { cortadas, restaram: deals.length, marcas: marcas.length },
      '[pins] Cortadas por procedência (sem banco, sem ficha, sem marca do nicho).'
    );
  }
  if (deals.length === 0) {
    console.error(
      `\n✗ As ${brutas.length} ofertas coletadas foram todas cortadas pelo filtro de qualidade.\n`
    );
    process.exit(1);
  }

  fs.mkdirSync(DESTINO, { recursive: true });

  const linhasMd: string[] = [
    '# Pins prontos pra publicar',
    '',
    `Nicho: **${niche.name}** · Link de destino (já marcado com \`?f=pin\`):`,
    '',
    '```',
    link,
    '```',
    '',
    '> Publique alguns por dia, não todos de uma vez - conta nova despejando 20 pins',
    '> em uma hora é o padrão que o Pinterest trata como spam.',
    '',
  ];

  let feitos = 0;
  for (const deal of deals.slice(0, quantidade)) {
    const preset = resolvePreset(deal.title, deal.id);
    const imagem = await fetchDealImage(deal, preset?.imagem);
    if (!imagem) {
      logger.warn({ id: deal.id, title: deal.title }, '[pins] Sem imagem - pulando.');
      continue;
    }

    feitos += 1;
    const arquivo = `pin-${String(feitos).padStart(2, '0')}.jpg`;
    const dados = dadosDoPin(deal, dominio);

    try {
      await geraPin(dados, imagem, path.join(DESTINO, arquivo));
    } catch (err) {
      feitos -= 1;
      logger.error({ err: (err as Error).message, id: deal.id }, '[pins] Falha ao gerar a arte.');
      continue;
    }

    linhasMd.push(
      `## ${arquivo}`,
      '',
      `**Título:** ${tituloPin(dados.nome, dados.precoAgora, dados.descontoPercent)}`,
      '',
      `**Descrição:** ${descricaoPin(dados.nome, dados.precoAgora, dados.precoDe, dados.notas)}`,
      '',
      `**Produto (pra conferir):** ${deal.affiliateUrl}`,
      '',
      '---',
      ''
    );
    logger.info({ arquivo, nome: dados.nome }, '[pins] Pin gerado.');
  }

  if (feitos === 0) {
    console.error('\n✗ Nenhum pin gerado (nenhuma oferta tinha imagem utilizável).\n');
    process.exit(1);
  }

  fs.writeFileSync(path.join(DESTINO, 'pins.md'), linhasMd.join('\n'), 'utf8');

  process.stdout.write(
    `\n✓ ${feitos} pin(s) em ${DESTINO}\n` +
      `   textos em ${path.join(DESTINO, 'pins.md')}\n` +
      `   destino de todos: ${link}\n\n`
  );
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, '[pins] Falhou.');
  process.exit(1);
});
