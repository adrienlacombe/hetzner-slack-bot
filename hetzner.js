const axios = require('axios');

const API_BASE = 'https://api.hetzner.cloud/v1';

function client() {
  return axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${process.env.HETZNER_API_TOKEN}` },
  });
}

async function getServerTypes() {
  const allTypes = [];
  let page = 1;
  while (true) {
    const { data } = await client().get('/server_types', { params: { per_page: 50, page } });
    allTypes.push(...data.server_types);
    if (page >= data.meta.pagination.last_page) break;
    page++;
  }
  return allTypes.filter((t) => !t.deprecated);
}

async function getLocations() {
  const { data } = await client().get('/locations');
  return data.locations;
}

async function getDatacenters() {
  const { data } = await client().get('/datacenters');
  return data.datacenters;
}

async function getImages() {
  const { data } = await client().get('/images', {
    params: { type: 'system', per_page: 50 },
  });
  return data.images.filter((i) => i.status === 'available' && !i.deprecated);
}

async function getSSHKeys() {
  const { data } = await client().get('/ssh_keys');
  return data.ssh_keys;
}

async function createServer({ name, server_type, image, location, ssh_keys, labels }) {
  const body = {
    name,
    server_type,
    image,
    location,
    start_after_create: true,
  };
  if (ssh_keys && ssh_keys.length) body.ssh_keys = ssh_keys;
  if (labels) body.labels = labels;

  const { data } = await client().post('/servers', body);
  return data;
}

async function listServers() {
  const { data } = await client().get('/servers', { params: { per_page: 50 } });
  return data.servers;
}

async function getServer(id) {
  const { data } = await client().get(`/servers/${id}`);
  return data.server;
}

async function deleteServer(id) {
  const { data } = await client().delete(`/servers/${id}`);
  return data;
}

module.exports = {
  getServerTypes,
  getLocations,
  getDatacenters,
  getImages,
  getSSHKeys,
  createServer,
  listServers,
  getServer,
  deleteServer,
};
