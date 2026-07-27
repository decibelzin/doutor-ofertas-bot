import fs from 'node:fs';
import path from 'node:path';
import type { Client, Message } from 'discord.js';
import { lerFunil } from '../core/funnel';
import { montarEmbedFunil, linhaBotoes } from './embeds/funil';
import { writeFileAtomic } from '../util/atomic';
import { config } from '../config';
import { logger } from '../logger';

/**
 * PAINÉIS DO FUNIL — mensagens que se atualizam sozinhas num canal.
 *
 * Persistidos em disco porque o alvo é uma mensagem específica: sem guardar o
 * `messageId`, um restart do serviço deixaria o painel no canal congelado pra
 * sempre, sem ninguém pra editá-lo.
 */

export interface Painel {
  guildId: string;
  channelId: string;
  messageId: string;
  /** Janela do funil mostrada neste painel. */
  dias: number;
  criadoEm: string;
  criadoPor: string;
}

const ARQUIVO = path.resolve('data/discord-paineis.json');

function carregar(): Painel[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')) as Painel[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function salvar(paineis: Painel[]): void {
  writeFileAtomic(ARQUIVO, JSON.stringify(paineis, null, 2));
}

/** Busca a mensagem do painel. `null` = sumiu (canal ou mensagem apagados). */
async function buscarMensagem(client: Client, p: Painel): Promise<Message | null> {
  try {
    const canal = await client.channels.fetch(p.channelId);
    if (!canal?.isTextBased()) return null;
    return await canal.messages.fetch(p.messageId);
  } catch {
    return null;
  }
}

async function renderizar(client: Client, p: Painel): Promise<boolean> {
  const msg = await buscarMensagem(client, p);
  if (!msg) return false;
  await msg.edit({
    embeds: [montarEmbedFunil(lerFunil(p.dias), { painel: true })],
    components: [linhaBotoes()],
  });
  return true;
}

/**
 * Cria (ou reaproveita) o painel de um canal.
 *
 * Reaproveita de propósito: rodar /funil duas vezes no mesmo canal deixaria
 * dois painéis competindo, e o antigo continuaria sendo atualizado — dois
 * números "ao vivo" no mesmo lugar é pior que nenhum.
 */
export async function criarPainel(
  client: Client,
  opts: { guildId: string; channelId: string; dias: number; criadoPor: string }
): Promise<{ url: string; reaproveitado: boolean }> {
  const paineis = carregar();
  const existente = paineis.find((p) => p.channelId === opts.channelId);

  if (existente) {
    existente.dias = opts.dias;
    const msg = await buscarMensagem(client, existente);
    if (msg) {
      await renderizar(client, existente);
      salvar(paineis);
      return { url: msg.url, reaproveitado: true };
    }
    // A mensagem foi apagada: cai fora e cria uma nova logo abaixo.
    paineis.splice(paineis.indexOf(existente), 1);
  }

  const canal = await client.channels.fetch(opts.channelId);
  if (!canal?.isTextBased() || !canal.isSendable()) {
    throw new Error('Não consigo enviar mensagem nesse canal — confira as permissões do bot.');
  }

  const msg = await canal.send({
    embeds: [montarEmbedFunil(lerFunil(opts.dias), { painel: true })],
    components: [linhaBotoes()],
  });

  paineis.push({
    guildId: opts.guildId,
    channelId: opts.channelId,
    messageId: msg.id,
    dias: opts.dias,
    criadoEm: new Date().toISOString(),
    criadoPor: opts.criadoPor,
  });
  salvar(paineis);
  logger.info({ canal: opts.channelId, dias: opts.dias }, '[discord] Painel do funil criado.');
  return { url: msg.url, reaproveitado: false };
}

/** Atualiza o painel que contém uma mensagem (usado pelo botão). */
export async function atualizarPorMensagem(client: Client, messageId: string): Promise<boolean> {
  const paineis = carregar();
  const p = paineis.find((x) => x.messageId === messageId);
  if (!p) return false;
  return renderizar(client, p);
}

/**
 * Atualiza todos os painéis. Painel cujo canal ou mensagem sumiu é removido do
 * arquivo — senão o laço tentaria editá-lo pra sempre, a cada ciclo.
 */
export async function atualizarTodos(client: Client): Promise<void> {
  const paineis = carregar();
  if (paineis.length === 0) return;

  const vivos: Painel[] = [];
  for (const p of paineis) {
    try {
      if (await renderizar(client, p)) vivos.push(p);
      else logger.warn({ canal: p.channelId, msg: p.messageId }, '[discord] Painel sumiu; removendo.');
    } catch (err) {
      // Erro transitório (rede, rate limit) não pode apagar o painel.
      logger.error({ err: (err as Error).message, canal: p.channelId }, '[discord] Falha ao atualizar painel.');
      vivos.push(p);
    }
  }
  if (vivos.length !== paineis.length) salvar(vivos);
}

export function iniciarLoopPaineis(client: Client): NodeJS.Timeout | null {
  const min = config.discord.funilRefreshMinutes;
  if (min <= 0) {
    logger.info('[discord] Atualização automática de painel desligada (DISCORD_FUNIL_REFRESH_MINUTES=0).');
    return null;
  }
  // Uma passada logo ao subir: depois de um restart o painel pode estar
  // mostrando número de horas atrás.
  void atualizarTodos(client).catch(() => undefined);

  logger.info({ minutos: min, paineis: carregar().length }, '[discord] Laço de atualização dos painéis ligado.');
  const t = setInterval(() => { void atualizarTodos(client).catch(() => undefined); }, min * 60_000);
  t.unref?.();
  return t;
}

export const listarPaineis = carregar;
