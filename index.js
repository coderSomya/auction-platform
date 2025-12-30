require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { randomUUID } = require("crypto");
const { pickWinner } = require("./ai");
const { CRICKETERS } = require("./cricketers");

const PORT = process.env.PORT || 3000;
const BID_WINDOW_MS = 30_000;

class Player {
  constructor(id, name, purse) {
    this.id = id;
    this.name = name;
    this.purse = Number(purse) || 0;
    this.squad = [];
  }

  addCricketer(cricketer, price) {
    this.purse -= price;
    this.squad.push({
      name: cricketer.name,
      basePrice: cricketer.basePrice,
      soldPrice: price
    });
  }
}

class AuctionGame {
  constructor(hostId, hostName, purse) {
    this.id = generateCode();
    this.hostId = hostId;
    this.status = "CREATED";
    this.winnerId = null;
    this.players = new Map();
    this.addPlayer(hostId, hostName, purse);
    this.queue = shuffle([...CRICKETERS]);
    this.currentCricketer = null;
    this.currentBid = null;
    this.timerEndsAt = null;
  }

  addPlayer(playerId, name, purse) {
    if (this.players.has(playerId)) return this.players.get(playerId);
    const player = new Player(playerId, name, purse);
    this.players.set(playerId, player);
    return player;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  start() {
    if (this.status !== "CREATED") return;
    this.status = "RUNNING";
    this.nextCricketer();
  }

  nextCricketer() {
    this.currentCricketer = this.queue.shift() || null;
    this.currentBid = null;
    if (this.currentCricketer) {
      this.timerEndsAt = Date.now() + BID_WINDOW_MS;
    } else {
      this.timerEndsAt = null;
      this.status = "OVER";
    }
    return this.currentCricketer;
  }

  placeBid(playerId, amount) {
    if (this.status !== "RUNNING" || !this.currentCricketer) {
      return { error: "Game not running or no cricketer available." };
    }
    const player = this.players.get(playerId);
    if (!player) return { error: "Player not part of this game." };
    const bidAmount = Number(amount);
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
      return { error: "Invalid bid amount." };
    }
    if (bidAmount < this.currentCricketer.basePrice) {
      return { error: "Bid below base price." };
    }
    if (this.currentBid && bidAmount <= this.currentBid.amount) {
      return { error: "Bid must be higher than current bid." };
    }
    if (bidAmount > player.purse) {
      return { error: "Insufficient purse for this bid." };
    }
    this.currentBid = {
      playerId,
      amount: bidAmount,
      at: Date.now()
    };
    this.timerEndsAt = Date.now() + BID_WINDOW_MS;
    return { ok: true };
  }

  settleIfExpired(now = Date.now()) {
    if (this.status !== "RUNNING" || !this.currentCricketer) return null;
    if (this.timerEndsAt && now < this.timerEndsAt) return null;
    const soldTo = this.currentBid ? this.players.get(this.currentBid.playerId) : null;
    const settledCricketer = this.currentCricketer;

    if (soldTo && settledCricketer) {
      soldTo.addCricketer(settledCricketer, this.currentBid.amount);
    }

    const result = {
      sold: Boolean(soldTo),
      cricketer: settledCricketer,
      winnerId: soldTo ? soldTo.id : null,
      price: this.currentBid ? this.currentBid.amount : null
    };

    this.nextCricketer();
    return result;
  }

  toJSON() {
    return {
      id: this.id,
      hostId: this.hostId,
      status: this.status,
      winnerId: this.winnerId,
      currentCricketer: this.currentCricketer,
      currentBid: this.currentBid,
      timerEndsAt: this.timerEndsAt,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        purse: p.purse,
        squad: p.squad
      })),
      remaining: this.queue.length
    };
  }
}

class AuctionManager {
  constructor() {
    this.games = new Map();
  }

  createGame(hostId, hostName, purse) {
    const game = new AuctionGame(hostId, hostName, purse);
    this.games.set(game.id, game);
    return game;
  }

  getGame(gameId) {
    return this.games.get(gameId);
  }

  joinGame(gameId, playerId, name, purse) {
    const game = this.games.get(gameId);
    if (!game) return { error: "Game not found." };
    if (game.status === "OVER") return { error: "Game already over." };
    game.addPlayer(playerId, name, purse);
    return { game };
  }

  leaveAll(playerId) {
    for (const game of this.games.values()) {
      if (game.players.has(playerId)) {
        game.removePlayer(playerId);
      }
    }
  }

  tick(now = Date.now()) {
    const settled = [];
    for (const game of this.games.values()) {
      const result = game.settleIfExpired(now);
      if (result) settled.push({ game, result });
      if (game.status === "OVER" && !game.players.size) {
        this.games.delete(game.id);
      }
    }
    return settled;
  }
}

const manager = new AuctionManager();
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const connections = new Map(); // playerId -> ws
const playerToGame = new Map(); // playerId -> gameId

const pendingWinner = new Set();

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(game, payload) {
  for (const player of game.players.values()) {
    const ws = connections.get(player.id);
    if (ws) send(ws, payload);
  }
}

function broadcastState(game) {
  broadcast(game, { type: "state", game: game.toJSON() });
}

wss.on("connection", (ws, req) => {
  const params = new URL(req.url || "", "http://localhost");
  const requestedId = params.searchParams.get("playerId");
  const playerId = requestedId || randomUUID();

  const existing = connections.get(playerId);
  if (existing && existing.readyState === WebSocket.OPEN) {
    try {
      existing.close();
    } catch (err) {
      // ignore
    }
  }

  connections.set(playerId, ws);
  send(ws, { type: "connected", playerId });

  ws.on("error", (err) => {
    console.error("WebSocket error", err);
  });

  ws.on("message", (message) => {
    let payload;
    try {
      payload = JSON.parse(message);
    } catch (err) {
      send(ws, { type: "error", message: "Invalid JSON." });
      return;
    }

    const { type, data = {} } = payload;

    if (type === "create_game") {
      const { name, purse } = data;
      const game = manager.createGame(playerId, name || "Host", purse || 100);
      playerToGame.set(playerId, game.id);
      send(ws, { type: "game_created", gameId: game.id, playerId });
      broadcastState(game);
      return;
    }

    if (type === "join_game") {
      const { gameId, name, purse } = data;
      const { game, error } = manager.joinGame(gameId, playerId, name || "Player", purse || 100);
      if (error) return send(ws, { type: "error", message: error });
      playerToGame.set(playerId, gameId);
      broadcast(game, { type: "player_joined", playerId, name });
      broadcastState(game);
      return;
    }

    if (type === "start_game") {
      const game = manager.getGame(data.gameId);
      if (!game) return send(ws, { type: "error", message: "Game not found." });
      if (game.hostId !== playerId) return send(ws, { type: "error", message: "Only host can start." });
      game.start();
      broadcast(game, { type: "game_started", gameId: game.id });
      if (game.currentCricketer) {
        broadcast(game, {
          type: "new_cricketer",
          cricketer: game.currentCricketer,
          timerEndsAt: game.timerEndsAt
        });
      }
      broadcastState(game);
      return;
    }

    if (type === "bid") {
      const game = manager.getGame(data.gameId);
      if (!game) return send(ws, { type: "error", message: "Game not found." });
      const result = game.placeBid(playerId, data.amount);
      if (result?.error) return send(ws, { type: "error", message: result.error });
      broadcast(game, {
        type: "bid_update",
        currentBid: game.currentBid,
        timerEndsAt: game.timerEndsAt
      });
      broadcastState(game);
      return;
    }

    if (type === "get_state") {
      const game = manager.getGame(data.gameId);
      if (!game) return send(ws, { type: "error", message: "Game not found." });
      send(ws, { type: "state", game: game.toJSON() });
      return;
    }

    if (type === "leave_game") {
      const gameId = playerToGame.get(playerId);
      if (gameId) {
        const game = manager.getGame(gameId);
        if (game) {
          game.removePlayer(playerId);
          broadcastState(game);
        }
      }
      playerToGame.delete(playerId);
      return;
    }

    send(ws, { type: "error", message: "Unknown action." });
  });

  ws.on("close", () => {
    connections.delete(playerId);
    playerToGame.delete(playerId);
    manager.leaveAll(playerId);
  });
});

setInterval(() => {
  const settled = manager.tick();
  settled.forEach(({ game, result }) => {
    broadcast(game, { type: "sold", ...result, timerEndsAt: game.timerEndsAt });
    if (game.currentCricketer) {
      broadcast(game, {
        type: "new_cricketer",
        cricketer: game.currentCricketer,
        timerEndsAt: game.timerEndsAt
      });
    }
    if (game.status === "OVER") {
      broadcast(game, { type: "game_over", gameId: game.id, winnerId: game.winnerId });
      ensureWinner(game);
    }
    broadcastState(game);
  });
}, 1_000);

server.listen(PORT, () => {
  console.log(`Auction server running at http://localhost:${PORT}`);
});

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function ensureWinner(game) {
  if (game.winnerId || pendingWinner.has(game.id)) return;
  if (!process.env.OPENAI_API_KEY) {
    broadcast(game, {
      type: "winner_declared",
      gameId: game.id,
      winnerId: null,
      error: "Missing OPENAI_API_KEY"
    });
    return;
  }
  pendingWinner.add(game.id);
  pickWinner(game.toJSON())
    .then((winnerId) => {
      game.winnerId = winnerId || null;
      broadcast(game, { type: "winner_declared", gameId: game.id, winnerId: game.winnerId });
      broadcastState(game);
    })
    .catch((err) => {
      console.error("AI winner selection failed", err);
      broadcast(game, {
        type: "winner_declared",
        gameId: game.id,
        winnerId: null,
        error: "AI selection failed"
      });
    })
    .finally(() => pendingWinner.delete(game.id));
}
