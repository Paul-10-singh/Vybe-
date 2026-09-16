/*
 * Peace music - command loader.
 *
 * Loads every command under src/commands (all subfolders) and returns
 * serialized payloads for REST PUT. No exclusions — the music bot has
 * well under 100 commands.
 */
const fs = require('fs');
const path = require('path');

function loadCommands() {
  const list = [];
  const commandsDir = path.join(__dirname, '..', 'src', 'commands');
  fs.readdirSync(commandsDir, { withFileTypes: true }).forEach((dir) => {
    if (!dir.isDirectory()) return;
    for (const file of fs.readdirSync(path.join(commandsDir, dir.name))) {
      if (!file.endsWith('.js')) continue;
      const command = require(path.join(commandsDir, dir.name, file));
      if (command?.data?.name) list.push(command.data.toJSON());
    }
  });
  return list;
}

module.exports = { loadCommands };