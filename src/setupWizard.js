const { getGuildConfig, saveGuildConfig } = require('./configStore');

const SETUP_STATES = new Map();

function getSetupState(guildId, userId) {
  const key = `${guildId}:${userId}`;
  return SETUP_STATES.get(key) || null;
}

function setSetupState(guildId, userId, data) {
  const key = `${guildId}:${userId}`;
  SETUP_STATES.set(key, data);
}

function clearSetupState(guildId, userId) {
  const key = `${guildId}:${userId}`;
  SETUP_STATES.delete(key);
}

function getGuildPrefix(guildId) {
  const config = getGuildConfig(guildId);
  return config.prefix || process.env.BOT_PREFIX || '!';
}

function getButtonStyle(isPrimary = false) {
  return isPrimary ? 3 : 2;
}

function createSetupButtons() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: getButtonStyle(true), label: 'Support Role', custom_id: 'setup_support_role' },
        { type: 2, style: getButtonStyle(false), label: 'Admin Role', custom_id: 'setup_admin_role' },
        { type: 2, style: getButtonStyle(false), label: 'Ticket Category', custom_id: 'setup_ticket_category' }
      ]
    },
    {
      type: 1,
      components: [
        { type: 2, style: getButtonStyle(false), label: 'Archive Category', custom_id: 'setup_archive_category' },
        { type: 2, style: getButtonStyle(false), label: 'Log Channel', custom_id: 'setup_log_channel' },
        { type: 2, style: getButtonStyle(false), label: 'Panel Channel', custom_id: 'setup_panel_channel' }
      ]
    },
    {
      type: 1,
      components: [
        { type: 2, style: getButtonStyle(false), label: 'Prefix', custom_id: 'setup_prefix' },
        { type: 2, style: getButtonStyle(false), label: 'Create Panel', custom_id: 'setup_create_panel' },
        { type: 2, style: getButtonStyle(true), label: 'Save Config', custom_id: 'setup_save' }
      ]
    }
  ];
}

async function sendSetupWizard(interaction) {
  const config = getGuildConfig(interaction.guildId);

  const embed = {
    title: '🎫 Ticket Bot Setup Wizard',
    description: 'Configure the ticket system in one place.',
    color: 0x5865F2,
    fields: [
      { name: 'Support Role', value: config.supportRoleId ? `<@&${config.supportRoleId}>` : 'Not set', inline: true },
      { name: 'Admin Role', value: config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Not set', inline: true },
      { name: 'Ticket Category', value: config.ticketCategoryId ? `<#${config.ticketCategoryId}>` : 'Not set', inline: true },
      { name: 'Archive Category', value: config.archiveCategoryId ? `<#${config.archiveCategoryId}>` : 'Not set', inline: true },
      { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true },
      { name: 'Panel Channel', value: config.panelChannelId ? `<#${config.panelChannelId}>` : 'Not set', inline: true },
      { name: 'Prefix', value: config.prefix || process.env.BOT_PREFIX || '!', inline: true }
    ],
    footer: { text: 'Use the buttons below to configure or type a custom mention/ID in the chat to set a value.' }
  };

  if (interaction.reply) {
    await interaction.reply({
      embeds: [embed],
      components: createSetupButtons(),
      ephemeral: false
    });
    return;
  }

  if (interaction.channel) {
    await interaction.channel.send({
      embeds: [embed],
      components: createSetupButtons()
    });
  }
}

module.exports = {
  SETUP_STATES,
  getSetupState,
  setSetupState,
  clearSetupState,
  getGuildPrefix,
  createSetupButtons,
  sendSetupWizard,
  saveGuildConfig,
  getGuildConfig
};
