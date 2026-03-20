const { App } = require('@slack/bolt');
const hetzner = require('./hetzner');
const modals = require('./modals');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// ─── Access control ────────────────────────────────────────────────────────────

const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? new Set(process.env.ALLOWED_USER_IDS.split(',').map((id) => id.trim()))
  : null; // null = no restriction

function isAllowed(userId) {
  return !ALLOWED_USERS || ALLOWED_USERS.has(userId);
}

// ─── /hetzner slash command ────────────────────────────────────────────────────

app.command('/hetzner', async ({ command, ack, respond }) => {
  await ack();
  if (!isAllowed(command.user_id)) {
    await respond({ response_type: 'ephemeral', text: 'You are not authorized to use this command.' });
    return;
  }
  await respond({
    response_type: 'ephemeral',
    text: 'Hetzner Cloud Manager',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Hetzner Cloud Manager' },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'What would you like to do?' },
      },
      {
        type: 'actions',
        block_id: 'hetzner_menu',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Create VM' },
            action_id: 'action_create_vm',
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'List VMs' },
            action_id: 'action_list_vms',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Delete VM' },
            action_id: 'action_delete_vm',
            style: 'danger',
          },
        ],
      },
    ],
  });
});

// ─── Create VM: open modal ─────────────────────────────────────────────────────

app.action('action_create_vm', async ({ ack, body, client }) => {
  await ack();
  try {
    const view = await modals.buildCreateVMStep1();
    await client.views.open({ trigger_id: body.trigger_id, view });
  } catch (err) {
    console.error('Failed to open create VM modal:', err.message);
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Failed to load Hetzner options: ${err.message}`,
    });
  }
});

// ─── Create VM Step 1: name + type → push step 2 with filtered locations ─────

app.view('create_vm_step1_submit', async ({ ack, view }) => {
  const vals = view.state.values;
  const name = vals.server_name.name_input.value;
  const serverType = vals.server_type.type_select.selected_option.value;

  // Validate server name (RFC 1123 hostname)
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    await ack({
      response_action: 'errors',
      errors: {
        server_name:
          'Must be a valid hostname: lowercase letters, numbers, and hyphens only (1-63 chars).',
      },
    });
    return;
  }

  const step2View = await modals.buildCreateVMStep2(name, serverType);
  await ack({ response_action: 'push', view: step2View });
});

// ─── Create VM Step 2: location + image + ssh → push confirmation ────────────

app.view('create_vm_step2_submit', async ({ ack, view }) => {
  const vals = view.state.values;
  const metadata = JSON.parse(view.private_metadata);

  const config = {
    name: metadata.name,
    server_type: metadata.server_type,
    location: vals.location.location_select.selected_option.value,
    image: vals.image.image_select.selected_option.value,
    ssh_keys: vals.ssh_keys?.ssh_select?.selected_options?.map((o) => o.value) || [],
  };

  await ack({
    response_action: 'push',
    view: modals.buildConfirmationModal(config),
  });
});

// ─── Create VM: confirmed → call Hetzner API ──────────────────────────────────

app.view('confirm_vm_create', async ({ ack, view, body, client }) => {
  await ack({ response_action: 'clear' });

  const config = JSON.parse(view.private_metadata);
  const userId = body.user.id;

  try {
    const result = await hetzner.createServer({
      name: config.name,
      server_type: config.server_type,
      image: config.image,
      location: config.location,
      ssh_keys: config.ssh_keys.map(Number),
      labels: { created_by: userId },
    });

    const server = result.server;
    const ipv4 = server.public_net.ipv4.ip;
    const rootPassword = result.root_password;

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Server Created Successfully' },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name:*\n${server.name}` },
          { type: 'mrkdwn', text: `*ID:*\n${server.id}` },
          { type: 'mrkdwn', text: `*Type:*\n${server.server_type.name}` },
          { type: 'mrkdwn', text: `*Location:*\n${server.datacenter.name}` },
          { type: 'mrkdwn', text: `*IPv4:*\n\`${ipv4}\`` },
          { type: 'mrkdwn', text: `*Status:*\n${server.status}` },
        ],
      },
    ];

    if (rootPassword) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:key: *Root password:* \`${rootPassword}\`\n_Save this now — it won't be shown again._`,
          },
        ],
      });
    }

    // DM the user with the result
    await client.chat.postMessage({
      channel: userId,
      text: `Server ${server.name} created — IP: ${ipv4}`,
      blocks,
    });

    // Poll until server is running, then notify
    pollServerReady(client, userId, server.id, server.name);
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    await client.chat.postMessage({
      channel: userId,
      text: `Failed to create server: ${errorMsg}`,
    });
  }
});

// ─── List VMs ──────────────────────────────────────────────────────────────────

app.action('action_list_vms', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  try {
    const servers = await hetzner.listServers();

    if (servers.length === 0) {
      await client.chat.postMessage({
        channel: userId,
        text: 'No servers found in this Hetzner project.',
      });
      return;
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Hetzner Servers (${servers.length})` },
      },
      { type: 'divider' },
    ];

    for (const s of servers) {
      const statusEmoji =
        s.status === 'running' ? ':large_green_circle:' : ':red_circle:';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `${statusEmoji} *${s.name}* (ID: ${s.id})`,
            `Type: ${s.server_type.name} | Location: ${s.datacenter.name}`,
            `IPv4: \`${s.public_net.ipv4.ip}\` | Status: *${s.status}*`,
          ].join('\n'),
        },
      });
      blocks.push({ type: 'divider' });
    }

    await client.chat.postMessage({
      channel: userId,
      text: `Found ${servers.length} server(s)`,
      blocks,
    });
  } catch (err) {
    await client.chat.postMessage({
      channel: userId,
      text: `Failed to list servers: ${err.message}`,
    });
  }
});

// ─── Delete VM: open modal ─────────────────────────────────────────────────────

app.action('action_delete_vm', async ({ ack, body, client }) => {
  await ack();
  try {
    const view = await modals.buildDeleteVMModal();
    await client.views.open({ trigger_id: body.trigger_id, view });
  } catch (err) {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Failed to load server list: ${err.message}`,
    });
  }
});

// ─── Delete VM: confirmed ──────────────────────────────────────────────────────

app.view('delete_vm_submit', async ({ ack, view, body, client }) => {
  await ack({ response_action: 'clear' });

  const serverId = view.state.values.server_select.server_choice.selected_option.value;
  const serverName =
    view.state.values.server_select.server_choice.selected_option.text.text;
  const userId = body.user.id;

  try {
    await hetzner.deleteServer(serverId);
    await client.chat.postMessage({
      channel: userId,
      text: `Server *${serverName}* (ID: ${serverId}) has been deleted.`,
    });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    await client.chat.postMessage({
      channel: userId,
      text: `Failed to delete server: ${errorMsg}`,
    });
  }
});

// ─── Poll server until ready ───────────────────────────────────────────────────

async function pollServerReady(client, userId, serverId, serverName) {
  const maxAttempts = 30;
  const intervalMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const server = await hetzner.getServer(serverId);
      if (server.status === 'running') {
        await client.chat.postMessage({
          channel: userId,
          text: `Server *${serverName}* is now running and ready to use.\nSSH: \`ssh root@${server.public_net.ipv4.ip}\``,
        });
        return;
      }
      if (server.status === 'off' || server.status === 'unknown') {
        await client.chat.postMessage({
          channel: userId,
          text: `Server *${serverName}* ended up in status: *${server.status}*. Please check the Hetzner console.`,
        });
        return;
      }
    } catch (err) {
      console.error(`Poll error for server ${serverId}:`, err.message);
    }
  }

  await client.chat.postMessage({
    channel: userId,
    text: `Server *${serverName}* is still initializing after ${(maxAttempts * intervalMs) / 1000}s. Check the Hetzner console for status.`,
  });
}

// ─── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log('Hetzner Slack Bot is running');
})();
