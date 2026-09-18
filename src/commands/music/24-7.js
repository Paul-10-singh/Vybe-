/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * /24-7 - 24/7 mode: the bot connects and stays sitting in the voice channel
 * (never auto-leaves). Running /24-7 once enables it; running it again while
 * it is active ends it (owner only — members are warned instead).
 *
 * While 24/7 is active, /stop and /disconnect warn that the bot is locked in
 * the channel. If the bot is ever dropped from voice after a play session it
 * automatically re-enables 24/7 and returns to the previously joined channel.
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { successEmbed, errorEmbed, warningEmbed } = require('../../utils/decorations');
const { requireVoice } = require('../../music/voice');
const { isBotOwner } = require('../../utils/permissions');
const { E } = require('../../utils/emojis');

module.exports = {
  data: new SlashCommandBuilder().setName('24-7').setDescription('24/7 mode — keep the bot sitting in the voice channel'),
  async execute(interaction, client) {
    const guildId = interaction.guild.id;
    const active = client.music.isStayConnected(guildId);

    // ── Active -> end the mode (owner only) ───────────────────────────
    if (active) {
      if (!(await isBotOwner(interaction, client))) {
        return reply(interaction, {
          embeds: [warningEmbed({ description: `${E['247']} The bot is in **24/7 mode** — only the bot owner can end it. Run \`/24-7\` to try. (You will be warned if you are not the owner.)` })],
          ephemeral: true,
        });
      }
      client.music.set247(guildId, false);
      const playing = Boolean(client.music.getQueue(guildId)?.currentTrack);
      if (playing) {
        return reply(interaction, {
          embeds: [successEmbed({ description: "24/7 mode ended — I'll leave the call once playback finishes." })],
        });
      }
      client.music.leave(guildId);
      return reply(interaction, {
        embeds: [successEmbed({ description: "24/7 mode ended — I'm free now and left the voice channel." })],
      });
    }

    // ── Not active -> enable & connect ───────────────────────────────
    const vc = requireVoice(interaction, client);
    if (!vc.ok) return reply(interaction, vc.reply);

    let queue = client.music.getQueue(guildId);
    if (!queue) {
      try {
        await client.music.ensureConnected(interaction.guild, vc.channel, { requestedBy: interaction.user.tag });
        queue = client.music.getQueue(guildId);
      } catch (err) {
        return reply(interaction, { embeds: [errorEmbed({ description: `Could not connect: ${err.message}` })] });
      }
    }

    client.music.set247(guildId, true);
    const channel = queue?.metadata?.channel || vc.channel;
    return reply(interaction, {
      embeds: [successEmbed({
        description: `I'm now in **24/7 mode** — I'll stay in <#${channel.id}> and never auto-leave.\nOnly the bot owner can end it with \`/24-7\`.`,
      })],
    });
  },
};