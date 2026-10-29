const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { getGuildConfig, saveGuildConfig, createTicketEntry, getTickets, getTicketByChannel, updateTicket } = require('./configStore');
const { sendSetupWizard, setSetupState, clearSetupState, getSetupState, getGuildPrefix } = require('./setupWizard');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getTicketNumber(guildId) {
  const config = getGuildConfig(guildId);
  const nextNumber = config.ticketCounter || 1;
  config.ticketCounter = nextNumber + 1;
  saveGuildConfig(guildId, config);
  return nextNumber;
}

async function createTicketChannel(guild, member, reason = 'General support') {
  const config = getGuildConfig(guild.id);
  const categoryId = config.ticketCategoryId || null;
  const supportRoleId = config.supportRoleId;
  const adminRoleId = config.adminRoleId;
  const ticketNumber = getTicketNumber(guild.id);
  const channelName = `ticket-${ticketNumber}`;

  const channel = await guild.channels.create({
    name: channelName,
    type: 0,
    parent: categoryId || undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ...(supportRoleId ? [{ id: supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : []),
      ...(adminRoleId ? [{ id: adminRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] }] : [])
    ]
  });

  const ticketData = {
    guildId: guild.id,
    ticketId: `T-${ticketNumber}`,
    channelId: channel.id,
    creatorId: member.id,
    creatorName: member.user.tag,
    status: 'open',
    priority: 'normal',
    claimedBy: null,
    notes: [],
    createdAt: new Date().toISOString(),
    reason
  };

  createTicketEntry(guild.id, ticketData);

  const infoEmbed = new EmbedBuilder()
    .setTitle('🎫 Ticket Opened')
    .setDescription(`A new ticket was created for **${member.user.tag}**.`)
    .addFields(
      { name: 'Ticket ID', value: ticketData.ticketId, inline: true },
      { name: 'Issue', value: reason || 'Not provided', inline: true },
      { name: 'Status', value: 'Open', inline: true }
    )
    .setColor(0x00AE86)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_close_${channel.id}`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_claim_${channel.id}`).setLabel('Claim Ticket').setStyle(ButtonStyle.Primary)
  );

  await channel.send({
    embeds: [infoEmbed],
    components: [row]
  });

  await channel.send({ content: `Welcome <@${member.id}>! Please describe your issue. A staff member will respond soon.` });

  return channel;
}

async function sendTicketPanel(guild, channel, messageText = 'Open a support ticket') {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Support Ticket')
    .setDescription(messageText)
    .setColor(0x5865F2)
    .addFields({ name: 'How it works', value: 'Click the button below to open a private support ticket.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket').setLabel('Open Ticket').setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function generateTicketLog(guild, ticket, text) {
  const config = getGuildConfig(guild.id);
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle('Ticket Log')
    .setDescription(text)
    .addFields(
      { name: 'Ticket ID', value: ticket.ticketId, inline: true },
      { name: 'Channel', value: `<#${ticket.channelId}>`, inline: true },
      { name: 'Creator', value: `<@${ticket.creatorId}>`, inline: true }
    )
    .setColor(0xF1C40F)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function closeTicket(guild, channel, reason = 'Ticket closed') {
  const ticket = getTicketByChannel(guild.id, channel.id);
  if (!ticket) return;

  updateTicket(guild.id, ticket.ticketId, () => ({ status: 'closed' }));

  const archiveCategoryId = getGuildConfig(guild.id).archiveCategoryId;
  if (archiveCategoryId) {
    await channel.setParent(archiveCategoryId).catch(() => {});
  }
  await channel.send({ content: `This ticket has been closed. Reason: ${reason}` });
  await generateTicketLog(guild, ticket, `Ticket closed: ${reason}`);
}

async function registerSlashCommands() {
  if (!GUILD_ID) return;
  const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return;

  const commands = [
    {
      name: 'setup',
      description: 'Open the all-in-one ticket setup wizard.'
    },
    {
      name: 'panel',
      description: 'Create a ticket panel in the current channel.'
    },
    {
      name: 'config',
      description: 'Show current ticket bot config.'
    },
    {
      name: 'prefix',
      description: 'Set or view the custom prefix.',
      options: [
        { name: 'value', description: 'New prefix to use', type: 3, required: false }
      ]
    },
    {
      name: 'ticket',
      description: 'Manage tickets.',
      options: [
        { name: 'new', description: 'Open a new ticket', type: 1 },
        { name: 'close', description: 'Close the current ticket', type: 1 },
        { name: 'info', description: 'See ticket info', type: 1 },
        { name: 'claim', description: 'Claim a ticket', type: 1 },
        { name: 'unclaim', description: 'Unclaim a ticket', type: 1 },
        { name: 'list', description: 'List active tickets', type: 1 }
      ]
    }
  ];

  await guild.commands.set(commands);
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'Tickets • /setup', type: 3 }], status: 'online' });
  await registerSlashCommands();
});

client.on('interactionCreate', async interaction => {
  if (interaction.isCommand()) {
    const { commandName, options } = interaction;
    const guildId = interaction.guildId;
    const config = getGuildConfig(guildId);

    if (commandName === 'setup') {
      await sendSetupWizard(interaction);
      return;
    }

    if (commandName === 'panel') {
      await sendTicketPanel(interaction.guild, interaction.channel, 'Click the button below to open a support ticket.');
      await interaction.reply({ content: 'Ticket panel created.', ephemeral: true });
      return;
    }

    if (commandName === 'config') {
      const embed = new EmbedBuilder()
        .setTitle('Ticket Bot Config')
        .setDescription('Current configuration for this server.')
        .addFields(
          { name: 'Prefix', value: config.prefix || process.env.BOT_PREFIX || '!', inline: true },
          { name: 'Support Role', value: config.supportRoleId ? `<@&${config.supportRoleId}>` : 'Not set', inline: true },
          { name: 'Admin Role', value: config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Not set', inline: true },
          { name: 'Ticket Category', value: config.ticketCategoryId ? `<#${config.ticketCategoryId}>` : 'Not set', inline: true },
          { name: 'Archive Category', value: config.archiveCategoryId ? `<#${config.archiveCategoryId}>` : 'Not set', inline: true },
          { name: 'Log Channel', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Not set', inline: true }
        )
        .setColor(0x5865F2);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (commandName === 'prefix') {
      const newPrefix = options.getString('value');
      if (newPrefix) {
        config.prefix = newPrefix;
        saveGuildConfig(guildId, config);
        await interaction.reply({ content: `Prefix updated to \`${newPrefix}\``, ephemeral: true });
      } else {
        await interaction.reply({ content: `Current prefix: \`${config.prefix || process.env.BOT_PREFIX || '!'}\``, ephemeral: true });
      }
      return;
    }

    if (commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'new') {
        const ticketChannel = await createTicketChannel(interaction.guild, interaction.member, 'General support');
        await interaction.reply({ content: `Your ticket was created: <#${ticketChannel.id}>`, ephemeral: false });
        return;
      }

      if (sub === 'close') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }

        await closeTicket(interaction.guild, interaction.channel, 'Closed through slash command.');
        await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
        return;
      }

      if (sub === 'info') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`Ticket ${ticket.ticketId}`)
          .addFields(
            { name: 'Creator', value: `<@${ticket.creatorId}>`, inline: true },
            { name: 'Status', value: ticket.status, inline: true },
            { name: 'Priority', value: ticket.priority || 'normal', inline: true }
          )
          .setColor(0x3498DB);

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === 'claim') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }
        updateTicket(guildId, ticket.ticketId, () => ({ claimedBy: interaction.user.id }));
        await interaction.reply({ content: `Ticket claimed by <@${interaction.user.id}>.`, ephemeral: true });
        return;
      }

      if (sub === 'unclaim') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }
        updateTicket(guildId, ticket.ticketId, () => ({ claimedBy: null }));
        await interaction.reply({ content: 'Ticket unclaimed.', ephemeral: true });
        return;
      }

      if (sub === 'list') {
        const active = getTickets(guildId).filter(ticket => ticket.status === 'open');
        if (!active.length) {
          await interaction.reply({ content: 'No active tickets.', ephemeral: true });
          return;
        }
        const list = active.map(ticket => `<#${ticket.channelId}> (${ticket.ticketId})`).join('\n');
        await interaction.reply({ content: `Active tickets:\n${list}`, ephemeral: true });
        return;
      }
    }
  }

  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'setup_support_role') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'support_role' });
      await interaction.reply({ content: 'Please send a role mention or role ID to set as the support role.', ephemeral: true });
      return;
    }

    if (customId === 'setup_admin_role') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'admin_role' });
      await interaction.reply({ content: 'Please send a role mention or role ID to set as the admin role.', ephemeral: true });
      return;
    }

    if (customId === 'setup_ticket_category') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'ticket_category' });
      await interaction.reply({ content: 'Please send a category mention or category ID to set as the ticket creation category.', ephemeral: true });
      return;
    }

    if (customId === 'setup_archive_category') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'archive_category' });
      await interaction.reply({ content: 'Please send a category mention or category ID to set as the archive category.', ephemeral: true });
      return;
    }

    if (customId === 'setup_log_channel') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'log_channel' });
      await interaction.reply({ content: 'Please send a channel mention or channel ID to set as the ticket log channel.', ephemeral: true });
      return;
    }

    if (customId === 'setup_panel_channel') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'panel_channel' });
      await interaction.reply({ content: 'Please send a channel mention or channel ID to set as the panel channel.', ephemeral: true });
      return;
    }

    if (customId === 'setup_prefix') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'prefix' });
      await interaction.reply({ content: 'Please send the desired prefix (for example: !, ?, or t!).', ephemeral: true });
      return;
    }

    if (customId === 'setup_create_panel') {
      await sendTicketPanel(interaction.guild, interaction.channel, 'Open a support ticket here.');
      await interaction.reply({ content: 'Ticket panel created.', ephemeral: true });
      return;
    }

    if (customId === 'setup_save') {
      const config = getGuildConfig(interaction.guildId);
      saveGuildConfig(interaction.guildId, config);
      await interaction.reply({ content: 'Ticket config saved successfully.', ephemeral: true });
      return;
    }

    if (customId.startsWith('ticket_close_')) {
      const channelId = customId.replace('ticket_close_', '');
      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        await interaction.reply({ content: 'That ticket channel could not be found.', ephemeral: true });
        return;
      }
      await closeTicket(interaction.guild, channel, 'Closed by button interaction');
      await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
      return;
    }

    if (customId.startsWith('ticket_claim_')) {
      const channelId = customId.replace('ticket_claim_', '');
      const ticket = getTicketByChannel(interaction.guildId, channelId);
      if (!ticket) {
        await interaction.reply({ content: 'No ticket found for that channel.', ephemeral: true });
        return;
      }
      updateTicket(interaction.guildId, ticket.ticketId, () => ({ claimedBy: interaction.user.id }));
      await interaction.reply({ content: `Ticket claimed by <@${interaction.user.id}>.`, ephemeral: true });
      return;
    }

    if (customId === 'open_ticket') {
      const ticketChannel = await createTicketChannel(interaction.guild, interaction.member, 'General support');
      await interaction.reply({ content: `Ticket opened: <#${ticketChannel.id}>`, ephemeral: true });
      return;
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const guildId = message.guildId;
  if (!guildId) return;

  const setupState = getSetupState(guildId, message.author.id);
  if (setupState) {
    const config = getGuildConfig(guildId);
    const rawValue = message.content.trim();
    const reference = rawValue.match(/(\d+)/)?.[1] || rawValue;

    if (setupState.type === 'support_role') {
      config.supportRoleId = reference;
    }
    if (setupState.type === 'admin_role') {
      config.adminRoleId = reference;
    }
    if (setupState.type === 'ticket_category') {
      config.ticketCategoryId = reference;
    }
    if (setupState.type === 'archive_category') {
      config.archiveCategoryId = reference;
    }
    if (setupState.type === 'log_channel') {
      config.logChannelId = reference;
    }
    if (setupState.type === 'panel_channel') {
      config.panelChannelId = reference;
    }
    if (setupState.type === 'prefix') {
      config.prefix = rawValue;
    }

    saveGuildConfig(guildId, config);
    clearSetupState(guildId, message.author.id);
    await message.reply(`Saved setting for **${setupState.type.replace('_', ' ')}**.`);
    return;
  }

  const prefix = getGuildPrefix(guildId);
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  const guild = message.guild;

  if (!command) return;

  if (command === 'ticket' || command === 't') {
    if (!args.length || args[0] === 'new') {
      const ticketChannel = await createTicketChannel(guild, message.member, 'General support');
      await message.reply(`Ticket created: <#${ticketChannel.id}>`);
      return;
    }

    if (args[0] === 'close') {
      const ticket = getTicketByChannel(guildId, message.channelId);
      if (!ticket) {
        await message.reply('This is not a ticket channel.');
        return;
      }
      await closeTicket(guild, message.channel, 'Closed through prefix command.');
      await message.reply('Ticket closed.');
      return;
    }

    if (args[0] === 'panel') {
      await sendTicketPanel(guild, message.channel, 'Open a support ticket here.');
      await message.reply('Panel created.');
      return;
    }

    if (args[0] === 'config') {
      const config = getGuildConfig(guildId);
      await message.reply(`Prefix: ${config.prefix || prefix}`);
      return;
    }
  }

  if (command === 'setup') {
    await sendSetupWizard({ guildId, guild, reply: async payload => message.reply(payload) });
  }
});

client.login(TOKEN);
