import type { Deal } from './deal';
import { resolvePreset } from '../format/title';
import { isInBank } from '../format/perfumes';
import { isPerfumeProduct } from '../providers/mercadolivre/coupons';

/**
 * FILTRO DE QUALIDADE DO CONTEÚDO - o que a marca aceita divulgar.
 *
 * Vive aqui, e não dentro do scheduler, porque não é regra de POSTAGEM: é
 * regra de MARCA. Vale pro post do WhatsApp, pro pin do Pinterest e pra
 * qualquer canal futuro. Enquanto morou só no scheduler, o gerador de pins
 * nasceu sem ele e produziu arte de "perfume de feromônios" de marca no-name,
 * com selo falso de "100% original" na foto do vendedor - publicado no
 * Pinterest isso é permanente e público, bem pior que um post que some no
 * histórico do grupo.
 *
 * ⚠️ Importar o scheduler pra reusar a regra não era opção: ele arrasta a
 * sessão do Baileys junto, e um CLI de gerar imagem não pode abrir WhatsApp.
 */

/**
 * É um perfume POSTÁVEL? Aceita perfume de verdade (keyword/marca - INCLUI
 * árabes e nicho fora do banco Fragrantica, ex.: Lattafa/Armaf/Al Wataniah/
 * French Avenue) e corta maquiagem/cabelo. Antes o gate era só `isInBank`, que
 * cortava justamente o segmento quente que os concorrentes postam.
 */
export function isKnownPerfume(deal: Deal): boolean {
  return isPerfumeProduct(deal.title) || resolvePreset(deal.title, deal.id) !== null;
}

/**
 * Termos do `searchTerms` que são GENÉRICOS, não marca. Servem pra varrer o
 * hub, mas não provam procedência: "perfume importado" casa com qualquer
 * coisa que se auto-declare importada, inclusive o no-name.
 */
const GENERICOS = /perfume|eau de|colôn|colon|masculin|feminin|import|arabe|árabe|unissex/i;

/**
 * Marcas confiáveis do nicho, derivadas do `ml.searchTerms` do próprio nicho.
 *
 * Reusar o searchTerms em vez de criar uma segunda lista é de propósito:
 * adicionar uma casa nova pra buscar passa a torná-la publicável no mesmo
 * gesto. Duas listas divergem — sempre.
 */
export function marcasDoNicho(searchTerms: string[] | undefined): string[] {
  return (searchTerms ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t && !GENERICOS.test(t));
}

/**
 * Sinais de categoria picareta. Perfume "de feromônio" é vendido como se
 * causasse atração química — alegação sem base que marketplace brasileiro está
 * cheio. Não entra em arte com a nossa marca em cima, venha de quem vier.
 */
const PICARETAGEM = /feromôn|feromon|afrodisíac|afrodisiac/i;

/**
 * Pode virar ARTE PÚBLICA (pin, criativo de anúncio)?
 *
 * Gate mais duro que o do WhatsApp de propósito: post em grupo some no
 * histórico, pin do Pinterest fica indexado e permanente. Exige procedência —
 * banco Fragrantica, ficha curada ou marca do nicho — em vez de só "é
 * perfume", que é o que deixava passar "Midnight Blue Alta Performance".
 *
 * O banco sozinho não serve: ele corta Maison Alhambra e Al Wataniah, que são
 * casas árabes legítimas e justamente o motor do nicho. Daí a marca entrar
 * como terceira via.
 */
export function isBrandSafe(deal: Deal, marcas: string[]): boolean {
  const titulo = deal.title.toLowerCase();
  if (PICARETAGEM.test(titulo)) return false;
  if (resolvePreset(deal.title, deal.id) !== null) return true;
  if (isInBank(deal.title)) return true;
  return marcas.some((m) => titulo.includes(m));
}
