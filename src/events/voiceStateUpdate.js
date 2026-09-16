/*
 * Peace music - voice state tracking.
 *
 * Feeds every voice move / join / leave into the music engine so it can run
 * its watchdog, auto-leave and 24/7 logic.
 */
module.exports = {
  name: 'music-voice',
  events: {
    voiceStateUpdate(client, oldState, newState) {
      client.music?.handleVoiceStateUpdate(oldState, newState);
    },
  },
};