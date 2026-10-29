const express = require('express');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, REST, Routes } = require('discord.js');
const { getGuildConfig, saveGuildConfig, getTickets, createTicketEntry, updateTicket, getTicketByChannel } = require('./configStore');
const { sendSetupWizard, setSetupState, clearSetupState, getSetupState, getGuildPrefix } = require('./setupWizard');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'discord-ticket-bot-premium-v2' });
});

app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

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
const PREFIX_FALLBACK = process.env.BOT_PREFIX || '!';

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

  const channel = await guild.channels.create({
    name: `ticket-${ticketNumber}`,
    parent: categoryId || undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ...(supportRoleId ? [{ id: supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : []),
      ...(adminRoleId ? [{ id: adminRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] }] : [])
    ],
    reason: `Ticket for ${member.user.tag}`
  });

  const ticket = {
    guildId: guild.id,
    ticketId: `T-${ticketNumber}`,
    channelId: channel.id,
    creatorId: member.id,
    creatorName: member.user.tag,
    reason,
    status: 'open',
    priority: 'normal',
    claimedBy: null,
    notes: [],
    createdAt: new Date().toISOString()
  };

  createTicketEntry(guild.id, ticket);

  const infoEmbed = new EmbedBuilder()
    .setTitle('🎫 Ticket Opened')
    .setDescription(`A new ticket was created for **${member.user.tag}**.`)
    .addFields(
      { name: 'Ticket ID', value: ticket.ticketId, inline: true },
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

  const channel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
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
  if (!CLIENT_ID || !GUILD_ID) return;

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commands = [
    { name: 'setup', description: 'Open the all-in-one ticket setup wizard.' },
    { name: 'panel', description: 'Create a support panel in this channel.' },
    { name: 'config', description: 'View the current ticket config.' },
    {
      name: 'prefix',
      description: 'Set or view the custom prefix.',
      options: [{ name: 'value', description: 'New prefix', type: 3, required: false }]
    },
    {
      name: 'ticket',
      description: 'Create, view, or manage a ticket.',
      options: [
        { name: 'new', description: 'Open a new ticket', type: 1 },
        { name: 'close', description: 'Close the current ticket', type: 1 },
        { name: 'info', description: 'View ticket information', type: 1 },
        { name: 'claim', description: 'Claim the current ticket', type: 1 },
        { name: 'unclaim', description: 'Unclaim the current ticket', type: 1 },
        { name: 'list', description: 'List open tickets', type: 1 }
      ]
    }
  ];

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'Tickets • /setup', type: 3 }], status: 'online' });
  await registerSlashCommands();
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
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
          { name: 'Prefix', value: config.prefix || PREFIX_FALLBACK, inline: true },
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
      const value = options.getString('value');
      if (value) {
        config.prefix = value;
        saveGuildConfig(guildId, config);
        await interaction.reply({ content: `Prefix updated to \`${value}\``, ephemeral: true });
      } else {
        await interaction.reply({ content: `Current prefix: \`${config.prefix || PREFIX_FALLBACK}\``, ephemeral: true });
      }
      return;
    }

    if (commandName === 'ticket') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'new') {
        const channel = await createTicketChannel(interaction.guild, interaction.member, 'General support');
        await interaction.reply({ content: `Ticket created: <#${channel.id}>`, ephemeral: false });
        return;
      }

      if (sub === 'close') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }

        await closeTicket(interaction.guild, interaction.channel, 'Closed by slash command.');
        await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
        return;
      }

      if (sub === 'info') {
        const ticket = getTicketByChannel(guildId, interaction.channelId);
        if (!ticket) {
          await interaction.reply({ content: 'This channel is not a ticket channel.', ephemeral: true });
          return;
        }

        const infoEmbed = new EmbedBuilder()
          .setTitle(`Ticket ${ticket.ticketId}`)
          .addFields(
            { name: 'Creator', value: `<@${ticket.creatorId}>`, inline: true },
            { name: 'Status', value: ticket.status, inline: true },
            { name: 'Priority', value: ticket.priority || 'normal', inline: true }
          )
          .setColor(0x3498DB);

        await interaction.reply({ embeds: [infoEmbed], ephemeral: true });
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
        const openTickets = getTickets(guildId).filter(ticket => ticket.status === 'open');
        if (!openTickets.length) {
          await interaction.reply({ content: 'There are no active tickets.', ephemeral: true });
          return;
        }

        const content = openTickets.map(ticket => `<#${ticket.channelId}> (${ticket.ticketId})`).join('\n');
        await interaction.reply({ content: `Open tickets:\n${content}`, ephemeral: true });
      }
    }
  }

  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === 'setup_support_role') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'support_role' });
      await interaction.reply({ content: 'Send a role mention or role ID to set the support role.', ephemeral: true });
      return;
    }

    if (customId === 'setup_admin_role') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'admin_role' });
      await interaction.reply({ content: 'Send a role mention or role ID to set the admin role.', ephemeral: true });
      return;
    }

    if (customId === 'setup_ticket_category') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'ticket_category' });
      await interaction.reply({ content: 'Send a category mention or category ID to set the ticket category.', ephemeral: true });
      return;
    }

    if (customId === 'setup_archive_category') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'archive_category' });
      await interaction.reply({ content: 'Send a category mention or category ID to set the archive category.', ephemeral: true });
      return;
    }

    if (customId === 'setup_log_channel') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'log_channel' });
      await interaction.reply({ content: 'Send a channel mention or channel ID to set the log channel.', ephemeral: true });
      return;
    }

    if (customId === 'setup_panel_channel') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'panel_channel' });
      await interaction.reply({ content: 'Send a channel mention or channel ID to set the panel channel.', ephemeral: true });
      return;
    }

    if (customId === 'setup_prefix') {
      setSetupState(interaction.guildId, interaction.user.id, { type: 'prefix' });
      await interaction.reply({ content: 'Send the prefix you want to use, such as !, ?, or ticket!', ephemeral: true });
      return;
    }

    if (customId === 'setup_create_panel') {
      await sendTicketPanel(interaction.guild, interaction.channel, 'Open a support ticket here.');
      await interaction.reply({ content: 'Ticket panel created in this channel.', ephemeral: true });
      return;
    }

    if (customId === 'setup_save') {
      const config = getGuildConfig(interaction.guildId);
      saveGuildConfig(interaction.guildId, config);
      await interaction.reply({ content: 'Ticket config saved.', ephemeral: true });
      return;
    }

    if (customId.startsWith('ticket_close_')) {
      const channelId = customId.replace('ticket_close_', '');
      const channel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        await interaction.reply({ content: 'Ticket channel not found.', ephemeral: true });
        return;
      }

      await closeTicket(interaction.guild, channel, 'Closed by button interaction.');
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
      await interaction.reply({ content: `Ticket generated: <#${ticketChannel.id}>`, ephemeral: true });
      return;
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;

  const setupState = getSetupState(message.guild.id, message.author.id);
  if (setupState) {
    const config = getGuildConfig(message.guild.id);
    const rawValue = message.content.trim();
    const value = rawValue.match(/(\d+)/)?.[1] || rawValue;

    if (setupState.type === 'support_role') config.supportRoleId = value;
    if (setupState.type === 'admin_role') config.adminRoleId = value;
    if (setupState.type === 'ticket_category') config.ticketCategoryId = value;
    if (setupState.type === 'archive_category') config.archiveCategoryId = value;
    if (setupState.type === 'log_channel') config.logChannelId = value;
    if (setupState.type === 'panel_channel') config.panelChannelId = value;
    if (setupState.type === 'prefix') config.prefix = rawValue;

    saveGuildConfig(message.guild.id, config);
    clearSetupState(message.guild.id, message.author.id);
    await message.reply(`Saved setting for **${setupState.type.replace('_', ' ')}**.`);
    return;
  }

  const prefix = getGuildPrefix(message.guild.id);
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  if (command === 'setup') {
    await sendSetupWizard({
      guildId: message.guild.id,
      guild: message.guild,
      reply: async payload => message.reply(payload)
    });
    return;
  }

  if (command === 'ticket' || command === 't') {
    const action = args[0]?.toLowerCase();

    if (!action || action === 'new') {
      const channel = await createTicketChannel(message.guild, message.member, 'General support');
      await message.reply(`Ticket created: <#${channel.id}>`);
      return;
    }

    if (action === 'close') {
      const ticket = getTicketByChannel(message.guild.id, message.channelId);
      if (!ticket) {
        await message.reply('This is not a ticket channel.');
        return;
      }

      await closeTicket(message.guild, message.channel, 'Closed through prefix command.');
      await message.reply('Ticket closed.');
      return;
    }

    if (action === 'panel') {
      await sendTicketPanel(message.guild, message.channel, 'Open a support ticket here.');
      await message.reply('Ticket panel created.');
      return;
    }

    if (action === 'config') {
      const guildConfig = getGuildConfig(message.guild.id);
      await message.reply(`Current prefix: \`${guildConfig.prefix || PREFIX_FALLBACK}\``);
      return;
    }
  }
});

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing. Please add it to your .env file.');
  process.exit(1);
}

client.login(TOKEN);
