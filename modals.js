const hetzner = require('./hetzner');

// Group server types by CPU architecture for readability
function groupServerTypes(serverTypes) {
  const groups = {};
  for (const st of serverTypes) {
    const prefix = st.name.replace(/\d+$/, '').toUpperCase();
    let label;
    if (prefix === 'CPX') label = 'Shared AMD';
    else if (prefix === 'CX') label = 'Shared Intel';
    else if (prefix === 'CAX') label = 'Arm64 (Ampere)';
    else if (prefix === 'CCX') label = 'Dedicated AMD';
    else label = prefix;

    if (!groups[label]) groups[label] = [];
    groups[label].push(st);
  }
  return groups;
}

async function buildCreateVMStep1() {
  const [serverTypes, locations, images, sshKeys] = await Promise.all([
    hetzner.getServerTypes(),
    hetzner.getLocations(),
    hetzner.getImages(),
    hetzner.getSSHKeys(),
  ]);

  const grouped = groupServerTypes(serverTypes);
  const serverTypeOptionGroups = Object.entries(grouped).map(([label, types]) => ({
    label: { type: 'plain_text', text: label },
    options: types
      .sort((a, b) => a.cores - b.cores || a.memory - b.memory)
      .map((t) => ({
        text: {
          type: 'plain_text',
          text: `${t.name} — ${t.cores}vCPU, ${t.memory}GB RAM, ${t.disk}GB`,
        },
        value: t.name,
      })),
  }));

  const locationOptions = locations.map((l) => ({
    text: { type: 'plain_text', text: `${l.city}, ${l.country} (${l.name})` },
    value: l.name,
  }));

  // Group images by OS flavor
  const imagesByFlavor = {};
  for (const img of images) {
    const flavor = img.os_flavor;
    if (!imagesByFlavor[flavor]) imagesByFlavor[flavor] = [];
    imagesByFlavor[flavor].push(img);
  }
  const imageOptionGroups = Object.entries(imagesByFlavor).map(([flavor, imgs]) => ({
    label: { type: 'plain_text', text: flavor.charAt(0).toUpperCase() + flavor.slice(1) },
    options: imgs.map((i) => ({
      text: { type: 'plain_text', text: i.description },
      value: i.name,
    })),
  }));

  const sshKeyOptions = sshKeys.map((k) => ({
    text: { type: 'plain_text', text: k.name },
    value: String(k.id),
  }));

  const blocks = [
    {
      type: 'input',
      block_id: 'server_name',
      label: { type: 'plain_text', text: 'Server Name' },
      element: {
        type: 'plain_text_input',
        action_id: 'name_input',
        placeholder: { type: 'plain_text', text: 'e.g. web-prod-01' },
      },
    },
    {
      type: 'input',
      block_id: 'server_type',
      label: { type: 'plain_text', text: 'Server Type' },
      element: {
        type: 'static_select',
        action_id: 'type_select',
        placeholder: { type: 'plain_text', text: 'Choose a server type' },
        option_groups: serverTypeOptionGroups,
      },
    },
    {
      type: 'input',
      block_id: 'location',
      label: { type: 'plain_text', text: 'Location' },
      element: {
        type: 'static_select',
        action_id: 'location_select',
        placeholder: { type: 'plain_text', text: 'Choose a datacenter location' },
        options: locationOptions,
      },
    },
    {
      type: 'input',
      block_id: 'image',
      label: { type: 'plain_text', text: 'Operating System' },
      element: {
        type: 'static_select',
        action_id: 'image_select',
        placeholder: { type: 'plain_text', text: 'Choose an OS image' },
        option_groups: imageOptionGroups,
      },
    },
  ];

  // SSH key selection is optional
  if (sshKeyOptions.length > 0) {
    blocks.push({
      type: 'input',
      block_id: 'ssh_keys',
      label: { type: 'plain_text', text: 'SSH Keys' },
      optional: true,
      element: {
        type: 'multi_static_select',
        action_id: 'ssh_select',
        placeholder: { type: 'plain_text', text: 'Select SSH keys (optional)' },
        options: sshKeyOptions,
      },
    });
  }

  return {
    type: 'modal',
    callback_id: 'create_vm_submit',
    title: { type: 'plain_text', text: 'Create Hetzner VM' },
    submit: { type: 'plain_text', text: 'Review & Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

function buildConfirmationModal(config) {
  return {
    type: 'modal',
    callback_id: 'confirm_vm_create',
    title: { type: 'plain_text', text: 'Confirm VM Creation' },
    submit: { type: 'plain_text', text: 'Create Server' },
    close: { type: 'plain_text', text: 'Back' },
    private_metadata: JSON.stringify(config),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Please confirm the following server configuration:*',
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name:*\n${config.name}` },
          { type: 'mrkdwn', text: `*Type:*\n${config.server_type}` },
          { type: 'mrkdwn', text: `*Location:*\n${config.location}` },
          { type: 'mrkdwn', text: `*Image:*\n${config.image}` },
          {
            type: 'mrkdwn',
            text: `*SSH Keys:*\n${config.ssh_keys.length ? config.ssh_keys.join(', ') : 'None (root password will be generated)'}`,
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':warning: This will create a billable resource in your Hetzner Cloud project.',
          },
        ],
      },
    ],
  };
}

async function buildDeleteVMModal() {
  const servers = await hetzner.listServers();

  if (servers.length === 0) {
    return {
      type: 'modal',
      callback_id: 'no_servers',
      title: { type: 'plain_text', text: 'Delete Server' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'No servers found in this project.' },
        },
      ],
    };
  }

  const serverOptions = servers.map((s) => ({
    text: {
      type: 'plain_text',
      text: `${s.name} (${s.server_type.name} — ${s.status}) — ${s.public_net.ipv4.ip}`,
    },
    value: String(s.id),
  }));

  return {
    type: 'modal',
    callback_id: 'delete_vm_submit',
    title: { type: 'plain_text', text: 'Delete Server' },
    submit: { type: 'plain_text', text: 'Delete' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'server_select',
        label: { type: 'plain_text', text: 'Select server to delete' },
        element: {
          type: 'static_select',
          action_id: 'server_choice',
          placeholder: { type: 'plain_text', text: 'Choose a server' },
          options: serverOptions,
          confirm: {
            title: { type: 'plain_text', text: 'Are you sure?' },
            text: {
              type: 'mrkdwn',
              text: 'This will permanently destroy the server and all its data.',
            },
            confirm: { type: 'plain_text', text: 'Yes, delete it' },
            deny: { type: 'plain_text', text: 'Cancel' },
            style: 'danger',
          },
        },
      },
    ],
  };
}

module.exports = {
  buildCreateVMStep1,
  buildConfirmationModal,
  buildDeleteVMModal,
};
