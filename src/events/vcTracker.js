/*
 * Peace✘ - Discord Bot
 * Developed by ACEtnc
 *
 * Feeds every voice join / leave / move into the VC activity tracker so
 * /vcstats, /vcstats_custom and /vchart stay current. Runs alongside the
 * music engine's own voice handler (music-voice).
 */
const vcTracker = require('../utils/vcTracker');

module.exports = {
  name: 'vc-tracker',
  events: {
    voiceStateUpdate(client, oldState, newState) {
      vcTracker.handleVoiceStateUpdate(oldState, newState);
    },
  },
};
