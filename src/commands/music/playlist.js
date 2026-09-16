/*
 * Peace✘ - Discord Bot
 * Developed by Smith.Code
 *
 * /playlist - per-user persistent playlists (MongoDB by default, local fallback).
 * Every user has a default **Liked** playlist ("liked"/"like" reserved by the ❤️
 * button) plus custom playlists created with a name and filled by pasting a URL
 * or song name. All playlists follow the user across every guild.
 */
const { SlashCommandBuilder } = require('discord.js');
const { reply } = require('../../utils/helpers');
const { chunkFieldValue } = require('../../utils/helpers');
const { commandEmbed, successEmbed, errorEmbed } = require('../../utils/decorations');
const { requireVoice } = require('../../music/voice');
const { postPanel } = require('../../music/nowPlaying');
const store = require('../../music/store');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage your personal playlists (Liked + custom)')
    .addSubcommand((s) => s.setName('play').setDescription('Play a playlist (by name, or "liked")')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name or "liked"').setRequired(true)))
    .addSubcommand((s) => s.setName('create').setDescription('Create an empty playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true)))
    .addSubcommand((s) => s.setName('add').setDescription('Add a track/URL to a playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name or "liked"').setRequired(true))
      .addStringOption((o) => o.setName('query').setDescription('Track name or URL').setRequired(true)))
    .addSubcommand((s) => s.setName('view').setDescription('View your playlists'))
    .addSubcommand((s) => s.setName('show').setDescription('Show tracks in a playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name or "liked"').setRequired(true)))
    .addSubcommand((s) => s.setName('load').setDescription('Load a playlist into the queue')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name or "liked"').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a playlist (cannot delete Liked)')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true))),
  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const name = (interaction.options.getString('name') || '').trim().slice(0, 40);
    const userId = interaction.user.id;

    switch (sub) {
      case 'create': {
        if (!name) return reply(interaction, { embeds: [errorEmbed({ description: 'Name is required.' })] });
        if (store.isReserved(name)) {
          return reply(interaction, { embeds: [errorEmbed({ description: '`liked` is your default playlist — you already have it (❤️ the songs you love).' })] });
        }
        const res = await store.createPlaylist(userId, name);
        if (!res.ok) return reply(interaction, { embeds: [errorEmbed({ description: `You already have a playlist **${name}**.` })] });
        return reply(interaction, { embeds: [successEmbed({ description: `Created playlist **${name}**. Add songs with \`/playlist add\`. ` })] });
      }

      case 'add': {
        const query = interaction.options.getString('query');
        await interaction.deferReply();
        try {
          const player = client.music.getPlayer();
          const result = await player.search(query);
          if (!result?.tracks?.length) return interaction.editReply({ embeds: [errorEmbed({ description: 'No tracks found for that query.' })] });
          const toAdd = result.playlist?.tracks?.length
            ? result.playlist.tracks.map((t) => ({ title: t.title, query: t.url }))
            : [{ title: result.tracks[0].title, query: result.tracks[0].url }];
          const label = store.isReserved(name) ? 'Liked' : name;
          for (const t of toAdd) {
            await store.addTrackTo(userId, name, { title: t.title, url: t.query });
          }
          const pls = await store.listPlaylists(userId);
          const plabel = pls.find((p) => p.name === store.normName(name))?.label || label;
          return interaction.editReply({
            embeds: [successEmbed({ description: `Added **${toAdd.length}** track(s) to **${plabel}**.` })],
          });
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed({ description: `Search failed: ${err.message}` })] });
        }
      }

      case 'view': {
        const pls = (await store.listPlaylists(userId)) || [];
        const onlyDefault = pls.length === 1;
        const lines = pls.map((p) => `• ${p.isDefault ? '❤️' : '📁'} **${p.label}** — ${p.tracks} ${p.tracks === 1 ? 'track' : 'tracks'}`);
        if (pls.length === 0 || (onlyDefault && pls[0].tracks === 0)) {
          return reply(interaction, { embeds: [errorEmbed({ description: 'No playlists yet. ❤️ a song from the playing card, or create one with `/playlist create`.' })] });
        }
        return reply(interaction, { embeds: [commandEmbed({ title: 'Your Playlists', description: lines.join('\n') + '\n\nPlay one with `/playlist play <name>`.' })] });
      }

      case 'show': {
        const tracks = await store.listTracks(userId, name);
        if (!tracks) return reply(interaction, { embeds: [errorEmbed({ description: `Playlist **${name}** not found.` })] });
        const label = store.isReserved(name) ? 'Liked' : name;
        if (!tracks.length) return reply(interaction, { embeds: [commandEmbed({ title: label, description: '_Empty playlist._' })] });
        const lines = tracks.map((t, i) => `\`${i + 1}.\` **${t.title}**${t.duration ? ` \`${t.duration}\`` : ''}`);
        const chunks = chunkFieldValue(lines);
        return reply(interaction, { embeds: [commandEmbed({ title: label, description: `${tracks.length} tracks`, fields: chunks.map((c) => ({ name: '\u200b', value: c })) })] });
      }

      case 'play':
      case 'load': {
        const vc = requireVoice(interaction, client);
        if (!vc.ok) return reply(interaction, vc.reply);
        await interaction.deferReply();
        const tracks = await store.listTracks(userId, name);
        if (!tracks || !tracks.length) {
          return interaction.editReply({ embeds: [errorEmbed({ description: `**${name}** is empty or not found.` })] });
        }
        const player = client.music;
        try {
          for (const t of tracks) {
            await player.play(interaction.guild, vc.channel, t.url, interaction.user.tag, interaction.user.id).catch(() => {});
          }
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed({ description: `Failed to load playlist: ${err.message}` })] });
        }
        const queue = client.music.getQueue(interaction.guild.id);
        const label = store.isReserved(name) ? 'Liked' : name;
        return interaction.editReply({
          embeds: [successEmbed({ description: `Loading **${label}** (${tracks.length} tracks) into the queue.` })],
        }).then(() => {
          if (queue) postPanel(client, queue, queue.metadata?.channel).catch(() => {});
        });
      }

      case 'delete': {
        if (store.isReserved(name)) {
          return reply(interaction, { embeds: [errorEmbed({ description: 'You can\'t delete your default **Liked** playlist.' })] });
        }
        const res = await store.removePlaylist(userId, name);
        if (!res.ok) return reply(interaction, { embeds: [errorEmbed({ description: `Playlist **${name}** not found.` })] });
        return reply(interaction, { embeds: [successEmbed({ description: `Deleted playlist **${name}**.` })] });
      }

      default:
        return reply(interaction, { embeds: [errorEmbed({ description: 'Unknown subcommand.' })] });
    }
  },
};