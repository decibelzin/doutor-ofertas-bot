import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * PRIMITIVAS DE ARTE - compartilhadas pelo card do site (og.jpg) e pelos pins.
 *
 * Saiu de dentro do build-site.ts quando o gerador de pins apareceu: as duas
 * artes usam a MESMA paleta, a mesma tipografia e o mesmo truque de ajuste de
 * corpo. Duplicar significaria que um ajuste de marca sairia em uma arte e não
 * na outra - defeito que só aparece semanas depois, no meio da divulgação.
 *
 * ⚠️ Depende de Anton/Impact e Arial INSTALADAS na máquina. Num Ubuntu limpo o
 * texto sai com fonte de fallback e a arte muda. Por isso o deploy não gera
 * arte na VPS: gere no Windows e commite (ver scripts/deploy-vps.sh).
 */

// ── Cores (espelham as custom properties de website/styles.css) ────────────
export const BG = '#0a0a0b';
export const GOLD = '#e8b84b';
export const GREEN = '#25d366';
export const TEXT = '#e5e2e3';
export const MUTED = '#9b8f7c';

/** Arte em alta pro card; cai pro JPG servido se a original não estiver aqui. */
const LOGO_FONTE = ['assets/logo-original.png', 'website/assets/logo.jpg'];

/**
 * Largura média de um caractere em CAIXA ALTA, relativa ao corpo da fonte.
 * Uma por família: Anton/Impact são condensadas e cabem quase 30% mais texto
 * que Arial Bold no mesmo corpo - usar um fator só fazia o texto em Arial
 * vazar da arte.
 *
 * Serve só pra ESCOLHER o corpo; o `textLength` é a trava real, então um erro
 * de estimativa aperta o texto em vez de deixá-lo vazar.
 */
const CHAR_W = { condensada: 0.47, arial: 0.62 } as const;
export type Familia = keyof typeof CHAR_W;

const FONTE: Record<Familia, string> = {
  condensada: 'Anton, Impact, sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
};

export const estimaLargura = (texto: string, corpo: number, familia: Familia): number =>
  texto.length * corpo * CHAR_W[familia];

/** Maior corpo (par) em que todas as linhas cabem em `largura`. */
export function ajustaCorpo(
  linhas: string[],
  largura: number,
  familia: Familia,
  max: number,
  min: number
): number {
  let corpo = max;
  while (corpo > min && Math.max(...linhas.map((l) => estimaLargura(l, corpo, familia))) > largura) {
    corpo -= 2;
  }
  return corpo;
}

export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export interface TextoOpts {
  corpo: number;
  cor: string;
  familia: Familia;
  largura: number;
  /** Só pra pílula: centraliza no x informado. */
  centro?: boolean;
  negrito?: boolean;
}

/** <text> que nunca ultrapassa `largura`, custe uma leve condensação. */
export function textoSvg(texto: string, x: number, y: number, o: TextoOpts): string {
  const trava =
    estimaLargura(texto, o.corpo, o.familia) > o.largura
      ? ` textLength="${Math.round(o.largura)}" lengthAdjust="spacingAndGlyphs"`
      : '';
  const ancora = o.centro ? ' text-anchor="middle"' : '';
  const peso = o.negrito ? ' font-weight="bold"' : '';
  return `<text x="${Math.round(x)}" y="${Math.round(y)}"${ancora} font-family="${FONTE[o.familia]}" font-size="${o.corpo}"${peso} fill="${o.cor}"${trava}>${escapeXml(texto)}</text>`;
}

/**
 * Logo recortado em círculo, no diâmetro pedido.
 *
 * Máscara alfa por `dest-in` - `border-radius` não existe em imagem composta,
 * e sem o recorte o logo entra como quadrado sobre o fundo escuro.
 */
export async function logoRedondo(diametro: number): Promise<Buffer> {
  const fonte = LOGO_FONTE.map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
  if (!fonte) throw new Error(`Nenhuma arte de logo encontrada (procurei: ${LOGO_FONTE.join(', ')}).`);

  const mascara = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diametro}" height="${diametro}"><circle cx="${diametro / 2}" cy="${diametro / 2}" r="${diametro / 2}" fill="#fff"/></svg>`
  );
  return sharp(fonte)
    .resize(diametro, diametro, { fit: 'cover' })
    .composite([{ input: mascara, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** Quebra um texto em no máximo `maxLinhas`, por palavra, cortando o excesso. */
export function quebraLinhas(texto: string, maxCharsPorLinha: number, maxLinhas: number): string[] {
  const palavras = texto.split(/\s+/).filter(Boolean);
  const linhas: string[] = [];
  let atual = '';

  for (const p of palavras) {
    const candidata = atual ? `${atual} ${p}` : p;
    if (candidata.length <= maxCharsPorLinha) {
      atual = candidata;
      continue;
    }
    if (atual) linhas.push(atual);
    atual = p;
    if (linhas.length === maxLinhas) break;
  }
  if (atual && linhas.length < maxLinhas) linhas.push(atual);

  return linhas.slice(0, maxLinhas);
}
