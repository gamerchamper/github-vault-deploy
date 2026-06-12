const TTL_MS = 45 * 1000;
const HEARTBEAT_MS = 15 * 1000;

const rooms = new Map();
const subscribers = new Map();
const roomMeta = new Map();
const ownerSubscribers = new Map();

const ADJECTIVES = [
  'Calm', 'Bright', 'Swift', 'Bold', 'Quiet', 'Lucky', 'Happy', 'Cool',
  'Keen', 'Warm', 'Neat', 'Fresh', 'Quick', 'Sunny', 'Clever', 'Gentle',
];
const ANIMALS = [
  'Fox', 'Owl', 'Bear', 'Hawk', 'Lynx', 'Wolf', 'Dove', 'Seal',
  'Crane', 'Panda', 'Tiger', 'Koala', 'Finch', 'Otter', 'Heron', 'Moose',
];
const COLORS = [
  '#5c6bc0', '#26a69a', '#ef5350', '#ab47bc', '#ffa726',
  '#42a5f5', '#66bb6a', '#ec407a', '#8d6e63', '#78909c',
];

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

function guestProfile(viewerId) {
  const h = hashCode(viewerId);
  const name = `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >> 4) % ANIMALS.length]}`;
  const color = COLORS[(h >> 8) % COLORS.length];
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return { name, color, initials };
}

function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, new Map());
  return rooms.get(token);
}

function setRoomMeta(token, meta) {
  if (!meta) return;
  roomMeta.set(token, {
    userId: meta.userId,
    fileId: meta.fileId,
    fileName: meta.fileName,
    isFolder: !!meta.isFolder,
    shareUrl: meta.shareUrl || null,
  });
}

function getRoomMeta(token) {
  return roomMeta.get(token) || null;
}

function pruneRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  const now = Date.now();
  let changed = false;
  for (const [id, viewer] of room) {
    if (now - viewer.lastSeen > TTL_MS) {
      room.delete(id);
      changed = true;
    }
  }
  if (!room.size) {
    rooms.delete(token);
    roomMeta.delete(token);
  }
  if (changed) {
    broadcast(token);
    broadcastOwners();
  }
}

function toPublicViewer(viewer) {
  return {
    id: viewer.id,
    name: viewer.name,
    color: viewer.color,
    initials: viewer.initials,
    joinedAt: viewer.joinedAt,
  };
}

function toDetailedViewer(viewer, token) {
  const now = Date.now();
  const meta = getRoomMeta(token);
  return {
    id: viewer.id,
    name: viewer.name,
    color: viewer.color,
    initials: viewer.initials,
    joinedAt: viewer.joinedAt,
    lastSeen: viewer.lastSeen,
    activeMs: now - viewer.joinedAt,
    idleMs: now - viewer.lastSeen,
    ip: viewer.ip || null,
    userAgent: viewer.userAgent || null,
    geo: viewer.geo || null,
    shareToken: token,
    shareName: meta?.fileName || 'Shared item',
    shareFileId: meta?.fileId || null,
    isFolder: !!meta?.isFolder,
    shareUrl: meta?.shareUrl || null,
  };
}

function listViewers(token) {
  pruneRoom(token);
  const room = rooms.get(token);
  if (!room) return [];
  return [...room.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(toPublicViewer);
}

function listViewersDetailed(token) {
  pruneRoom(token);
  const room = rooms.get(token);
  if (!room) return [];
  return [...room.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((viewer) => toDetailedViewer(viewer, token));
}

function listLiveForUser(userId, shares = []) {
  const shareMap = new Map(shares.map((s) => [s.share_token, s]));
  const sessions = [];
  let totalViewers = 0;

  for (const [token, share] of shareMap) {
    const meta = getRoomMeta(token) || {
      userId,
      fileId: share.id,
      fileName: share.name,
      isFolder: !!share.is_folder,
      shareUrl: share.share_url || null,
    };

    if (meta.userId && meta.userId !== userId) continue;

    const viewers = listViewersDetailed(token);
    if (!viewers.length) continue;

    totalViewers += viewers.length;
    sessions.push({
      token,
      fileId: meta.fileId || share.id,
      fileName: meta.fileName || share.name,
      isFolder: !!meta.isFolder,
      shareUrl: meta.shareUrl,
      viewerCount: viewers.length,
      viewers,
    });
  }

  sessions.sort((a, b) => b.viewerCount - a.viewerCount);

  return {
    totalViewers,
    activeShares: sessions.length,
    sessions,
    at: Date.now(),
  };
}

function broadcast(token) {
  const viewers = listViewers(token);
  const payload = JSON.stringify({ viewers, at: Date.now() });
  const subs = subscribers.get(token);
  if (subs) {
    for (const res of subs) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        subs.delete(res);
      }
    }
  }
}

function broadcastOwners() {
  const payload = JSON.stringify({ at: Date.now() });
  for (const subs of ownerSubscribers.values()) {
    for (const res of subs) {
      try {
        res.write(`data: ${payload}\n\n`);
      } catch {
        subs.delete(res);
      }
    }
  }
}

function join(token, viewerId, clientInfo = {}) {
  const room = getRoom(token);
  const profile = guestProfile(viewerId);
  const now = Date.now();
  const existing = room.get(viewerId);

  const viewer = {
    id: viewerId,
    name: existing?.name || profile.name,
    color: existing?.color || profile.color,
    initials: existing?.initials || profile.initials,
    joinedAt: existing?.joinedAt || now,
    lastSeen: now,
    ip: clientInfo.ip || existing?.ip || null,
    userAgent: clientInfo.userAgent || existing?.userAgent || null,
    geo: clientInfo.geo || existing?.geo || null,
  };

  room.set(viewerId, viewer);
  broadcast(token);
  broadcastOwners();
  return toPublicViewer(viewer);
}

function heartbeat(token, viewerId, clientInfo = {}) {
  const room = rooms.get(token);
  if (!room?.has(viewerId)) return null;
  const viewer = room.get(viewerId);
  viewer.lastSeen = Date.now();
  if (clientInfo.ip) viewer.ip = clientInfo.ip;
  if (clientInfo.userAgent) viewer.userAgent = clientInfo.userAgent;
  if (clientInfo.geo) viewer.geo = clientInfo.geo;
  broadcast(token);
  broadcastOwners();
  return toPublicViewer(viewer);
}

function leave(token, viewerId) {
  const room = rooms.get(token);
  if (!room?.has(viewerId)) return;
  room.delete(viewerId);
  if (!room.size) {
    rooms.delete(token);
    roomMeta.delete(token);
  }
  broadcast(token);
  broadcastOwners();
}

function subscribe(token, res) {
  if (!subscribers.has(token)) subscribers.set(token, new Set());
  subscribers.get(token).add(res);
  res.write(`data: ${JSON.stringify({ viewers: listViewers(token), at: Date.now() })}\n\n`);
}

function unsubscribe(token, res) {
  subscribers.get(token)?.delete(res);
}

function subscribeOwner(userId, res) {
  if (!ownerSubscribers.has(userId)) ownerSubscribers.set(userId, new Set());
  ownerSubscribers.get(userId).add(res);
}

function unsubscribeOwner(userId, res) {
  ownerSubscribers.get(userId)?.delete(res);
}

setInterval(() => {
  for (const token of [...rooms.keys()]) pruneRoom(token);
}, HEARTBEAT_MS);

module.exports = {
  TTL_MS,
  HEARTBEAT_MS,
  join,
  heartbeat,
  leave,
  listViewers,
  listViewersDetailed,
  listLiveForUser,
  setRoomMeta,
  getRoomMeta,
  subscribe,
  unsubscribe,
  subscribeOwner,
  unsubscribeOwner,
  guestProfile,
};
