import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import { config } from '../../config';
import { lerPausa } from '../../core/pausa';
import { OURO, VERDE, VERMELHO, agora, minutosAtras } from './comum';

/**
 * STATUS — a resposta pra "está tudo bem?".
 *
 * O bot do Discord é um processo separado do bot do WhatsApp, então ele não
 * pergunta nada pro outro: lê os MESMOS arquivos que o outro escreve
 * (posted.json, groups.json, pausa.json) e sonda o site por HTTP. Isso é
 * melhor que IPC aqui — se o processo do WhatsApp estiver morto, um IPC daria
 * timeout, enquanto o arquivo parado no tempo denuncia exatamente isso.
 */

interface Registro { dealId: string; ts: number }

function lerPostados(): Registro[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(config.store.file), 'utf8')) as Registro[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

interface GroupsFile {
  updatedAt: string;
  join: string | null;
  totalMembers: number;
  /** Ausente em groups.json gravado antes desse campo existir. */
  totalPeople?: number;
  groups: { name: string; members: number; people?: number; vacancies: number; full: boolean }[];
}

function lerGrupos(): { arquivo: string; dados: GroupsFile | null } {
  // Uma landing por nicho: o groups.json fica em <site.dir>/<slug>/groups.json.
  const candidatos = fs
    .readdirSync(path.resolve(config.site.dir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.resolve(config.site.dir, d.name, 'groups.json'))
    .filter((p) => fs.existsSync(p));

  const arquivo = candidatos[0];
  if (!arquivo) return { arquivo: '(nenhum)', dados: null };
  try {
    return { arquivo, dados: JSON.parse(fs.readFileSync(arquivo, 'utf8')) as GroupsFile };
  } catch {
    return { arquivo, dados: null };
  }
}

/**
 * Gente de verdade, sem contar o bot.
 *
 * `members` do Baileys inclui o próprio bot em cada grupo: 10 grupos vazios
 * apareciam como "10 membros". Cai pro cálculo antigo em arquivo gravado antes
 * do campo existir.
 */
function pessoas(g: GroupsFile): number {
  if (typeof g.totalPeople === 'number') return g.totalPeople;
  // groups.json antigo: desconta 1 (o bot) de cada grupo.
  return g.groups.reduce((s, x) => s + (x.people ?? Math.max(0, x.members - 1)), 0);
}

async function sondarSite(): Promise<{ ok: boolean; detalhe: string }> {
  const url = 'https://doutoroferta.com.br/perfumes';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    return { ok: res.ok, detalhe: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detalhe: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message };
  }
}

const dentroDaJanela = (): boolean => {
  const h = Number(
    new Date().toLocaleString('pt-BR', { timeZone: config.timezone, hour: '2-digit', hour12: false })
  );
  return h >= config.schedule.startHour && h < config.schedule.endHour;
};

export async function montarStatus(): Promise<EmbedBuilder> {
  const pausa = lerPausa();
  const registros = lerPostados();
  const { arquivo: arqGrupos, dados: grupos } = lerGrupos();
  const site = await sondarSite();

  const agoraMs = Date.now();
  const naHora = new Set(registros.filter((r) => r.ts >= agoraMs - 3600_000).map((r) => r.dealId)).size;
  const inicioDia = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone })).setHours(0, 0, 0, 0);
  const noDia = new Set(registros.filter((r) => r.ts >= inicioDia).map((r) => r.dealId)).size;
  const ultimo = registros.length ? Math.max(...registros.map((r) => r.ts)) : 0;
  const minSemPostar = ultimo ? Math.round((agoraMs - ultimo) / 60_000) : null;

  // groups.json parado é o sinal mais confiável de que o bot do WhatsApp morreu:
  // ele reescreve a cada SITE_REFRESH_MINUTES, então idade >> isso = problema.
  const idadeGrupos = grupos ? Math.round((agoraMs - new Date(grupos.updatedAt).getTime()) / 60_000) : null;
  const grupoParado = idadeGrupos !== null && idadeGrupos > config.site.refreshMinutes * 3;

  const problema = !site.ok || grupoParado || !grupos;
  const e = new EmbedBuilder()
    .setColor(problema ? VERMELHO : pausa ? OURO : VERDE)
    .setTitle(pausa ? '⏸️ Status — PAUSADO' : problema ? '⚠️ Status — algo errado' : '✅ Status — tudo certo')
    .setTimestamp(new Date());

  if (pausa) {
    e.setDescription(
      `Postagem **pausada** por \`${pausa.por}\` ${minutosAtras(new Date(pausa.desde).getTime())}.` +
        (pausa.motivo ? `\nMotivo: _${pausa.motivo}_` : '') +
        (pausa.ate ? `\nRetoma sozinho ${agora(new Date(pausa.ate).getTime())}.` : '\nSó retoma no comando.')
    );
  }

  const teto = config.schedule.maxPostsPerDay ? `/${config.schedule.maxPostsPerDay}` : '';
  e.addFields(
    {
      name: 'Postagem',
      value:
        `Janela ${config.schedule.startHour}h–${config.schedule.endHour}h — ` +
        `**${dentroDaJanela() ? 'aberta' : 'fechada'}**\n` +
        `Nesta hora: **${naHora}/${config.schedule.maxPostsPerHour}**\n` +
        `Hoje: **${noDia}${teto}**\n` +
        `Última: ${minSemPostar === null ? '—' : minutosAtras(ultimo)}`,
      inline: true,
    },
    {
      name: 'Grupos',
      value: grupos
        ? `**${grupos.groups.length}** grupos · **${pessoas(grupos)}** pessoas\n` +
          `Botão do site aponta pra: ${grupos.join ? '**ok**' : '**NENHUM**'}\n` +
          `Atualizado ${minutosAtras(new Date(grupos.updatedAt).getTime())}` +
          (grupoParado ? '\n⚠️ **parado — bot do WhatsApp caiu?**' : '')
        : `⚠️ não consegui ler\n\`${arqGrupos}\``,
      inline: true,
    },
    {
      name: 'Site',
      value: site.ok ? `✅ no ar (${site.detalhe})` : `❌ **fora do ar** (${site.detalhe})`,
    }
  );

  e.setFooter({ text: 'lido dos arquivos que o bot do WhatsApp escreve + sonda HTTP no site' });
  return e;
}
