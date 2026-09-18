/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * /disconnect - disconnect the bot from voice (admin-only).
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { successEmbed, errorEmbed, warningEmbed } = require('../../utils/decorations');
const { clearPanel } = require('../../music/nowPlaying');
const { E } = require('../../utils/emojis');

module.exports = {
  data: new SlashCommandBuilder().setName('disconnect').setDescription('Disconnect the bot from the voice channel'),
  async execute(interaction, client) {
    const guildId = interaction.guild.id;

    // 24/7 enforces availability: the bot must not be disconnected while it
    // is locked into the channel — /disconnect only warns in that case.
    if (client.music.isStayConnected(guildId)) {
      return reply(interaction, {
        embeds: [warningEmbed({
          description: `${E['247']} The bot is in **24/7 mode** — it cannot be disconnected. Only the bot owner can end it with \`/24-7\`.`,
        })],
        ephemeral: true,
      });
    }

    const queue = client.music.getQueue(guildId);
    if (queue) {
      clearPanel(guildId);
      queue.delete();
    }
    const member = interaction.guild?.members?.me;
    const vc = member?.voice?.channel;
    try {
      await member.voice.disconnect();
    } catch {}
    return reply(interaction, { embeds: [successEmbed({ description: vc ? `Left <#${vc.id}>` : 'Disconnected from voice.' })] });
  },
};
