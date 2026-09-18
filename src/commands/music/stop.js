/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * /stop - stop playback and clear the queue.
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { successEmbed, errorEmbed, warningEmbed } = require('../../utils/decorations');
const { clearPanel } = require('../../music/nowPlaying');
const { E } = require('../../utils/emojis');

module.exports = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  async execute(interaction, client) {
    const guildId = interaction.guild.id;

    // 24/7 enforces availability: while it is active the bot must stay in
    // voice, so /stop only warns that the bot is locked into the channel.
    if (client.music.isStayConnected(guildId)) {
      return reply(interaction, {
        embeds: [warningEmbed({
          description: `${E['247']} The bot is in **24/7 mode** — it stays connected to the voice channel.\nOnly the bot owner can end it with \`/24-7\`.`,
        })],
        ephemeral: true,
      });
    }

    const queue = client.music.getQueue(guildId);
    if (!queue || !queue.currentTrack) {
      return reply(interaction, { embeds: [errorEmbed({ description: 'Nothing is playing.' })], ephemeral: true });
    }
    clearPanel(guildId);
    queue.node.stop();
    queue.clear();
    return reply(interaction, { embeds: [successEmbed({ description: 'Stopped and cleared the queue.' })] });
  },
};
