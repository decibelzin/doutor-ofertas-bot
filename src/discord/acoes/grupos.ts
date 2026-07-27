import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import { config } from '../../config';
import { OURO, VERDE, VERMELHO, minutosAtras } from './comum';

/** GRUPOS — o estado dos grupos de WhatsApp e pra onde o botão do site aponta. */

interface Grupo { name: string; link: string | null; members: number; vacancies: number; full: boolean }
interface GroupsFile { updatedAt: string; limit: number; join: string | null; totalMembers: number; groups: Grupo[] }

/** Um groups.json por nicho: <site.dir>/<slug>/groups.json. */
function lerTodos(): { slug: string; dados: GroupsFile }[] {
  const raiz = path.resolve(config.site.dir);
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: { slug: string; dados: GroupsFile }[] = [];
  for (const slug of dirs) {
    const arq = path.join(raiz, slug, 'groups.json');
    try {
      out.push({ slug, dados: JSON.parse(fs.readFileSync(arq, 'utf8')) as GroupsFile });
    } catch {
      /* pasta sem groups.json (ex.: assets) — normal */
    }
  }
  return out;
}

export function montarGrupos(): EmbedBuilder {
  const nichos = lerTodos();

  if (nichos.length === 0) {
    return new EmbedBuilder()
      .setColor(VERMELHO)
      .setTitle('⚠️ Grupos — nenhum dado')
      .setDescription(
        `Não achei nenhum \`groups.json\` em \`${config.site.dir}\`.\n` +
          'Quem escreve esse arquivo é o bot do WhatsApp — se ele estiver fora do ar, ' +
          'não há o que ler.'
      );
  }

  const e = new EmbedBuilder().setColor(VERDE).setTitle('👥 Grupos').setTimestamp(new Date());

  for (const { slug, dados } of nichos) {
    const idadeMin = Math.round((Date.now() - new Date(dados.updatedAt).getTime()) / 60_000);
    const parado = idadeMin > config.site.refreshMinutes * 3;
    if (parado) e.setColor(OURO);

    // O primeiro com vaga é pra onde o site manda a pessoa — é o que importa.
    const proximo = dados.groups.find((g) => !g.full && g.link);

    const linhas = dados.groups.map((g, i) => {
      const marca = g.link && g.link === dados.join ? '**→**' : '  ';
      const cheio = g.full ? ' 🔴 CHEIO' : '';
      const semLink = g.link ? '' : ' ⚠️ sem link (bot é admin?)';
      return `${marca} \`${String(i + 1).padStart(2)}\` ${g.members} membros · ${g.vacancies} vagas${cheio}${semLink}`;
    });

    e.addFields({
      name: `${slug} — ${dados.totalMembers} membros em ${dados.groups.length} grupos`,
      value:
        linhas.join('\n').slice(0, 1000) +
        `\n\nBotão do site → ${proximo ? `grupo **${dados.groups.indexOf(proximo) + 1}**` : '**NENHUM com vaga**'}` +
        `\nAtualizado ${minutosAtras(new Date(dados.updatedAt).getTime())}` +
        (parado ? ' ⚠️ **parado**' : ''),
    });
  }

  e.setFooter({ text: '→ marca o grupo pra onde o botão da landing está mandando agora' });
  return e;
}
