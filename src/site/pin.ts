import sharp from 'sharp';
import type { Deal } from '../core/deal';
import { resolvePreset, cleanTitle } from '../format/title';
import { lookupNotas } from '../format/perfumes';
import { formatPrice } from '../format/whatsapp';
import {
  BG, GOLD, GREEN, TEXT, MUTED,
  ajustaCorpo, estimaLargura, logoRedondo, quebraLinhas, textoSvg,
} from './arte';

/**
 * PIN DO PINTEREST - 1000x1500 (proporção 2:3, a que o Pinterest mostra maior).
 *
 * Reusa a MESMA paleta e tipografia do card do site (src/site/arte.ts), então
 * quem vê um pin e depois cai na landing reconhece que é o mesmo lugar.
 *
 * Decisão de composição: a foto do anúncio entra dentro de um CARTÃO BRANCO,
 * não solta sobre o fundo escuro. Foto de e-commerce vem com fundo branco
 * recortado - jogada direto no preto, o produto fica dentro de um retângulo
 * branco acidental, que é exatamente a cara de arte amadora. O cartão
 * transforma esse defeito em intenção.
 *
 * O que domina a arte é PREÇO e DESCONTO, não o nome: no feed do Pinterest o
 * pin aparece com ~236px de largura, e nesse tamanho só número grande sobrevive.
 */

const W = 1000;
const H = 1500;
const M = 60;                       // margem lateral
const COL = W - M * 2;              // largura útil de texto

const LOGO_D = 88;
const CARD_Y = 170;
const CARD_H = 780;
const IMG_PAD = 40;

const BADGE_R = 88;
const BADGE_CX = 890;
const BADGE_CY = 230;

const PILULA_Y = 1360;
const PILULA_H = 88;
const PILULA_TXT = 'GRUPO GRÁTIS NO WHATSAPP';

/** Baseline máxima do preço grande - trava pra ele nunca encostar na pílula. */
const PRECO_MAX_Y = 1320;

export interface DadosPin {
  /** Nome curto exibido (ficha curada quando existe, senão título limpo). */
  nome: string;
  precoAgora: number;
  precoDe?: number | undefined;
  descontoPercent?: number | undefined;
  notas?: string[] | undefined;
  dominio: string;
}

/** Extrai da oferta o que a arte precisa - mesma regra de nome do post. */
export function dadosDoPin(deal: Deal, dominio: string): DadosPin {
  const preset = resolvePreset(deal.title, deal.id);
  const notas = preset?.notas?.length ? preset.notas : lookupNotas(deal.title);
  return {
    nome: preset?.nome ?? cleanTitle(deal.title),
    precoAgora: deal.priceNow,
    precoDe: deal.priceOriginal && deal.priceOriginal > deal.priceNow ? deal.priceOriginal : undefined,
    descontoPercent: deal.discountPercent ? Math.round(deal.discountPercent) : undefined,
    notas: notas && notas.length > 0 ? notas.slice(0, 3) : undefined,
    dominio,
  };
}

export async function geraPin(dados: DadosPin, imagem: Buffer, destino: string): Promise<void> {
  const partes: string[] = [];

  // ── Cabeçalho: logo + marca + domínio ───────────────────────────────────
  partes.push(
    textoSvg('DOUTOR OFERTAS', M + LOGO_D + 24, 96, {
      corpo: 42, cor: GOLD, familia: 'condensada', largura: COL - LOGO_D - 24,
    }),
    textoSvg(dados.dominio, M + LOGO_D + 24, 130, {
      corpo: 24, cor: MUTED, familia: 'arial', largura: COL - LOGO_D - 24,
    })
  );

  // ── Cartão branco da foto ───────────────────────────────────────────────
  partes.push(
    `<rect x="${M}" y="${CARD_Y}" width="${COL}" height="${CARD_H}" rx="36" fill="#ffffff"/>`
  );

  // ── Nome do produto (até 2 linhas) ──────────────────────────────────────
  const nomeUp = dados.nome.toUpperCase().replace(/\s+/g, ' ').trim();
  const linhas = quebraLinhas(nomeUp, 26, 2);
  /* Reticências quando sobrou palavra de fora: sem isso o nome termina num
     fragmento solto ("... 100ML ALTA") e lê como erro de renderização, não
     como corte proposital. */
  if (linhas.join(' ').length < nomeUp.length && linhas.length > 0) {
    linhas[linhas.length - 1] = `${linhas[linhas.length - 1]}…`;
  }
  const corpoNome = ajustaCorpo(linhas, COL, 'condensada', 62, 34);
  const LH = Math.round(corpoNome * 1.06);
  let y = 1040;
  for (const [i, l] of linhas.entries()) {
    partes.push(textoSvg(l, M, y, { corpo: corpoNome, cor: TEXT, familia: 'condensada', largura: COL }));
    if (i < linhas.length - 1) y += LH;
  }

  // ── Notas (só quando o banco casou com segurança) ───────────────────────
  if (dados.notas?.length) {
    y += 56;
    partes.push(
      textoSvg(dados.notas.join('  ·  '), M, y, {
        corpo: 28, cor: MUTED, familia: 'arial', largura: COL,
      })
    );
  }

  // ── Preço ───────────────────────────────────────────────────────────────
  if (dados.precoDe) {
    y += 56;
    const txt = `DE R$ ${formatPrice(dados.precoDe)}`;
    /* 0.92 porque CHAR_W é calibrado pra LETRA em caixa alta, e preço é quase
       só dígito e pontuação, que são mais estreitos - sem o ajuste o risco
       sobrava uns 15px além do texto. */
    const largura = Math.min(estimaLargura(txt, 30, 'arial') * 0.92, COL);
    partes.push(
      textoSvg(txt, M, y, { corpo: 30, cor: MUTED, familia: 'arial', largura: COL }),
      // Risco desenhado à mão: `text-decoration` não é confiável no renderizador
      // de SVG do sharp, e um preço "de" sem risco vira só um número confuso.
      `<line x1="${M}" y1="${Math.round(y - 9)}" x2="${Math.round(M + largura)}" y2="${Math.round(y - 9)}" stroke="${MUTED}" stroke-width="3"/>`
    );
  }

  y = Math.min(y + 98, PRECO_MAX_Y);
  partes.push(
    textoSvg(`R$ ${formatPrice(dados.precoAgora)}`, M, y, {
      corpo: 104, cor: GOLD, familia: 'condensada', largura: COL,
    })
  );

  // ── Pílula do rodapé (posição FIXA em todos os pins) ────────────────────
  // Fixa de propósito: no feed os pins aparecem lado a lado, e rodapé dançando
  // de altura entre um e outro faz a série parecer de gente diferente.
  partes.push(
    `<rect x="${M}" y="${PILULA_Y}" width="${COL}" height="${PILULA_H}" rx="${PILULA_H / 2}" fill="${GREEN}"/>`,
    textoSvg(PILULA_TXT, W / 2, PILULA_Y + PILULA_H / 2 + 13, {
      corpo: 38, cor: BG, familia: 'arial', largura: COL - 60, centro: true, negrito: true,
    })
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="brilho">
      <stop offset="0%" stop-color="${GOLD}" stop-opacity=".20"/>
      <stop offset="70%" stop-color="${BG}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <circle cx="${W / 2}" cy="${CARD_Y + CARD_H / 2}" r="620" fill="url(#brilho)"/>
  ${partes.join('\n  ')}
</svg>`;

  // `contain` sobre branco: a foto do ML raramente é quadrada, e `cover`
  // cortaria justamente a tampa/rótulo do frasco, que é o que identifica o
  // perfume na miniatura.
  const foto = await sharp(imagem)
    .resize(COL - IMG_PAD * 2, CARD_H - IMG_PAD * 2, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();

  const logo = await logoRedondo(LOGO_D);

  /* O selo é composto DEPOIS da foto, não desenhado no SVG de base.
     Ele invade a área do cartão de propósito (é o que dá profundidade), e a
     foto entra por cima do SVG - desenhado junto, o selo ficava escondido
     atrás da foto em todo pin com desconto. */
  const selo: { input: Buffer; left: number; top: number }[] = [];
  if (dados.descontoPercent && dados.descontoPercent > 0) {
    const D = BADGE_R * 2;
    const svgSelo = `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}">
  <circle cx="${BADGE_R}" cy="${BADGE_R}" r="${BADGE_R}" fill="${GOLD}"/>
  ${textoSvg(`${dados.descontoPercent}%`, BADGE_R, BADGE_R + 8, {
    corpo: 62, cor: BG, familia: 'condensada', largura: BADGE_R * 1.7, centro: true,
  })}
  ${textoSvg('OFF', BADGE_R, BADGE_R + 52, {
    corpo: 28, cor: BG, familia: 'arial', largura: BADGE_R * 1.5, centro: true, negrito: true,
  })}
</svg>`;
    selo.push({
      input: await sharp(Buffer.from(svgSelo)).png().toBuffer(),
      left: BADGE_CX - BADGE_R,
      top: BADGE_CY - BADGE_R,
    });
  }

  await sharp(Buffer.from(svg))
    .composite([
      { input: foto, left: M + IMG_PAD, top: CARD_Y + IMG_PAD },
      ...selo,
      { input: logo, left: M, top: 48 },
    ])
    .jpeg({ quality: 88, progressive: true, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(destino);
}
