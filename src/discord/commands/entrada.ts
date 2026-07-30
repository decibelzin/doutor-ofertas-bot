import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { montarEntrada } from '../entrada';
import { logger } from '../../logger';

/**
 * /entrada - publica no canal a mensagem com o botão que entrega o cargo.
 *
 * Admin-only igual ao /painel: quem publica a porta de entrada é quem manda no
 * servidor. Clicar no botão, esse sim, é livre pra qualquer um.
 */
export const data = new SlashCommandBuilder()
  .setName('entrada')
  .setDescription('Publica neste canal a mensagem de entrada com o botão de virar membro')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const canal = interaction.channel;
  if (!canal || !canal.isTextBased() || canal.isDMBased()) {
    await interaction.reply({
      content: 'Rode este comando dentro de um canal de texto do servidor.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  /* `canal.send()` e NAO `interaction.reply()`.
     Resposta de interação sai grudada num cabeçalho "Fulano usou /entrada", o
     que denuncia o comando e faz a porta de entrada parecer conversa de admin
     em vez de aviso oficial do servidor. Enviando pelo canal, a mensagem nasce
     solta - como se o bot tivesse postado sozinho.
     O reconhecimento da interação vai em efêmero: o Discord exige alguma
     resposta em até 3s, senão mostra "a aplicação não respondeu". */
  try {
    await canal.send(montarEntrada());
  } catch (err) {
    logger.error(
      { err: (err as Error).message, canal: interaction.channelId },
      '[discord] Não consegui publicar a mensagem de entrada.'
    );
    await interaction.reply({
      content: 'Não consegui postar aqui. Confira se o bot tem permissão de enviar mensagem neste canal.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: '✅ Mensagem de entrada publicada.', flags: MessageFlags.Ephemeral });
  logger.info(
    { usuario: interaction.user.tag, canal: interaction.channelId },
    '[discord] Mensagem de entrada publicada.'
  );
}
