// snap-server.mjs
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.SNAP_SERVER_PORT
  ? Number(process.env.SNAP_SERVER_PORT)
  : 8080;

const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_PAYLOAD_BYTES = 256 * 1024;

// Map of WebSocket -> { role: "p1" | "p2" | null, isAlive: boolean, gameId: string | null }
const clientMeta = new Map();

/**
 * Each game = one 1v1 match:
 * {
 *   id: string,
 *   roles: { p1: WebSocket | null, p2: WebSocket | null },
 *   scores: { p1: number, p2: number }
 * }
 */
const games = new Map();
let nextGameId = 1;

// We still play 1v1; this constant just keeps it obvious
const MAX_PLAYERS_PER_GAME = 2;

// Canonical match config (shared across all games)
const matchConfig = {
  pointsToWin: 7, // still fine; client uses 4 for best-of-7 (first to 4)
};

const wss = new WebSocketServer({
  port: PORT,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

// ---------- helpers ----------

function safeSend(ws, payloadObj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  let json;
  try {
    json = JSON.stringify(payloadObj);
  } catch (err) {
    console.warn("[SnapBattle] Failed to stringify payload:", err);
    return;
  }

  try {
    ws.send(json);
  } catch (err) {
    console.warn("[SnapBattle] Failed to send message:", err);
  }
}

/**
 * Convenience: get the game object this socket belongs to, or null.
 */
function getGameForSocket(ws) {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.gameId) return null;
  const game = games.get(meta.gameId);
  if (!game) return null;
  return game;
}

/**
 * Send score-update to a single client, scoped to their game.
 */
function sendScoreUpdate(ws) {
  const game = getGameForSocket(ws);
  if (!game) return;

  safeSend(ws, {
    type: "score-update",
    scoreP1: game.scores.p1,
    scoreP2: game.scores.p2,
    pointsToWin: matchConfig.pointsToWin,
  });
}

/**
 * Broadcast score-update to all players in a given game.
 */
function broadcastScoreUpdateForGame(game) {
  const targets = [game.roles.p1, game.roles.p2];

  for (const ws of targets) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendScoreUpdate(ws);
    }
  }
}

/**
 * Reset scores for a single game.
 */
function resetMatchForGame(game) {
  game.scores.p1 = 0;
  game.scores.p2 = 0;
  console.log(
    `[SnapBattle] Match reset for game ${game.id}. Scores => P1: 0, P2: 0`
  );
  broadcastScoreUpdateForGame(game);
}

/**
 * Assign a client into the "next possible open game" for their requested role.
 * - If some game has that role free → put them there
 * - Else create a new game and park them as that role
 */
function assignClientToGame(ws, desiredRole) {
  const role = desiredRole === "p2" ? "p2" : "p1";

  let meta = clientMeta.get(ws);
  if (!meta) {
    meta = { role: null, isAlive: true, gameId: null };
    clientMeta.set(ws, meta);
  } else if (meta.gameId && meta.role) {
    // Already assigned; just re-sync scores and bail
    console.log(
      `[SnapBattle] Client already assigned to game ${meta.gameId} as ${meta.role}`
    );
    sendScoreUpdate(ws);
    return;
  }

  // 1) Try to find an existing game where this role slot is free
  let targetGame = null;
  for (const game of games.values()) {
    const currentP1 = !!game.roles.p1;
    const currentP2 = !!game.roles.p2;
    const currentPlayers = (currentP1 ? 1 : 0) + (currentP2 ? 1 : 0);

    if (currentPlayers >= MAX_PLAYERS_PER_GAME) continue;
    if (!game.roles[role]) {
      targetGame = game;
      break;
    }
  }

  // 2) If none, create a brand new game
  if (!targetGame) {
    const gameId = `g${nextGameId++}`;
    targetGame = {
      id: gameId,
      roles: { p1: null, p2: null },
      scores: { p1: 0, p2: 0 },
    };
    games.set(gameId, targetGame);
    console.log(`[SnapBattle] Created new game ${gameId}`);
  }

  // 3) Claim the role in that game
  targetGame.roles[role] = ws;

  meta.role = role;
  meta.gameId = targetGame.id;

  const p1Present = !!targetGame.roles.p1;
  const p2Present = !!targetGame.roles.p2;

  console.log(
    `[SnapBattle] Client identified as ${role} in game ${targetGame.id}. ` +
      `Occupancy => P1=${p1Present}, P2=${p2Present}`
  );

  // Immediately sync their HUD with the current scores for THIS game
  sendScoreUpdate(ws);
}

// ---------- message handlers ----------

function handleHello(ws, data) {
  const desiredRole = data && data.role === "p2" ? "p2" : "p1";
  assignClientToGame(ws, desiredRole);
}

function handleState(ws, data) {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.role || !meta.gameId) return;

  const game = games.get(meta.gameId);
  if (!game) return;

  const fromRole = meta.role;
  const toRole = fromRole === "p1" ? "p2" : "p1";
  const dest = game.roles[toRole];

  if (!dest || dest.readyState !== WebSocket.OPEN) return;

  safeSend(dest, {
    type: "remote-state",
    from: fromRole,
    snapX: typeof data.snapX === "number" ? data.snapX : 0,
    snapY: typeof data.snapY === "number" ? data.snapY : 0,
    crouch: typeof data.crouch === "number" ? data.crouch : 0,
    aimX: typeof data.aimX === "number" ? data.aimX : 0,
    aimY: typeof data.aimY === "number" ? data.aimY : 0,
    exposure: typeof data.exposure === "number" ? data.exposure : 0,
    targetX: typeof data.targetX === "number" ? data.targetX : null,
    targetY: typeof data.targetY === "number" ? data.targetY : null,
    targetZ: typeof data.targetZ === "number" ? data.targetZ : null,
    t: typeof data.t === "number" ? data.t : 0,
  });
}

function handleShot(ws, data) {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.role || !meta.gameId) return;

  const game = games.get(meta.gameId);
  if (!game) return;

  const fromRole = meta.role;
  const toRole = fromRole === "p1" ? "p2" : "p1";
  const dest = game.roles[toRole];

  if (!dest || dest.readyState !== WebSocket.OPEN) return;

  safeSend(dest, {
    type: "shot",
    from: fromRole,
    start: data.start || null,
    velocity: data.velocity || null,
    radius:
      typeof data.radius === "number" ? data.radius : undefined,
    color: data.color || undefined,
    t: typeof data.t === "number" ? data.t : Date.now() / 1000,
  });
}

function handleHit(ws, data) {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.role || !meta.gameId) return;

  const game = games.get(meta.gameId);
  if (!game) return;

  const fromRole = meta.role;
  const kind = data && typeof data.kind === "string" ? data.kind : "enemy";

  if (kind === "enemy") {
    if (fromRole === "p1") {
      game.scores.p1 += 1;
    } else {
      game.scores.p2 += 1;
    }

    console.log(
      `[SnapBattle] Hit from ${fromRole} in game ${game.id}. ` +
        `Scores => P1: ${game.scores.p1}, P2: ${game.scores.p2}`
    );

    broadcastScoreUpdateForGame(game);
  }
}

function handleResetMatch(ws) {
  const meta = clientMeta.get(ws);
  if (!meta || !meta.gameId) return;

  const game = games.get(meta.gameId);
  if (!game) return;

  resetMatchForGame(game);
}

// ---------- server events ----------

wss.on("connection", (ws) => {
  console.log("[SnapBattle] Client connected");

  clientMeta.set(ws, {
    role: null,
    isAlive: true,
    gameId: null,
  });

  ws.on("pong", () => {
    const meta = clientMeta.get(ws);
    if (meta) {
      meta.isAlive = true;
    }
  });

  ws.on("message", (raw) => {
    let data;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      data = JSON.parse(text);
    } catch (err) {
      console.warn("[SnapBattle] Bad JSON message:", err);
      return;
    }

    if (!data || typeof data.type !== "string") return;

    switch (data.type) {
      case "hello":
        handleHello(ws, data);
        break;
      case "state":
        handleState(ws, data);
        break;
      case "shot":
        handleShot(ws, data);
        break;
      case "hit":
        handleHit(ws, data);
        break;
      case "reset-match":
        handleResetMatch(ws, data);
        break;
      default:
        break;
    }
  });

  ws.on("close", () => {
    const meta = clientMeta.get(ws);

    if (meta && meta.gameId) {
      const game = games.get(meta.gameId);
      if (game && meta.role) {
        if (game.roles[meta.role] === ws) {
          game.roles[meta.role] = null;
        }

        const stillP1 = !!game.roles.p1;
        const stillP2 = !!game.roles.p2;

        if (!stillP1 && !stillP2) {
          games.delete(meta.gameId);
          console.log(
            `[SnapBattle] Game ${meta.gameId} deleted (no players).`
          );
        } else {
          console.log(
            `[SnapBattle] Client ${meta.role} left game ${meta.gameId}. ` +
              `Remaining => P1=${stillP1}, P2=${stillP2}`
          );
        }
      }
    }

    clientMeta.delete(ws);
    console.log("[SnapBattle] Client disconnected");
  });

  ws.on("error", (err) => {
    console.warn("[SnapBattle] Client error:", err);
  });
});

// Heartbeat loop
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const meta = clientMeta.get(ws);
    if (!meta) continue;

    if (!meta.isAlive) {
      console.log("[SnapBattle] Terminating unresponsive client");
      try {
        ws.terminate();
      } catch (err) {
        console.warn("[SnapBattle] Error terminating client:", err);
      }
      continue;
    }

    meta.isAlive = false;
    try {
      ws.ping();
    } catch (err) {
      console.warn("[SnapBattle] Failed to ping client:", err);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

console.log(
  `[SnapBattle] WebSocket server listening on ws://localhost:${PORT}`
);
