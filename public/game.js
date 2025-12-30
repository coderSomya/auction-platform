// Keep player identity per browser tab to avoid disconnecting other tabs.
function getStoredPlayerId() {
  return sessionStorage.getItem("auction_player_id");
}

function storePlayerId(id) {
  sessionStorage.setItem("auction_player_id", id);
}

class SocketClient {
  constructor(url, handlers) {
    this.handlers = handlers;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("open", () => this.handlers.onOpen?.());
    this.ws.addEventListener("close", () => this.handlers.onClose?.());
    this.ws.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        this.handlers.onMessage?.(payload);
      } catch (err) {
        console.error("Bad message", err);
      }
    });
  }

  send(type, data = {}) {
    this.ws.send(JSON.stringify({ type, data }));
  }
}

class AuctionUI {
  constructor() {
    this.connectionStatus = document.getElementById("connectionStatus");
    this.gameIdDisplay = document.getElementById("gameIdDisplay");
    this.playersList = document.getElementById("playersList");
    this.gameStatus = document.getElementById("gameStatus");
    this.currentName = document.getElementById("currentName");
    this.basePrice = document.getElementById("basePrice");
    this.timer = document.getElementById("timer");
    this.currentBid = document.getElementById("currentBid");
    this.bidder = document.getElementById("bidder");
    this.squads = document.getElementById("squads");
    this.startBtn = document.getElementById("startBtn");
    this.copyCodeBtn = document.getElementById("copyCodeBtn");
  }

  setConnection(status) {
    this.connectionStatus.textContent = status;
  }

  setGameId(gameId) {
    this.gameIdDisplay.textContent = gameId || "—";
  }

  renderPlayers(players) {
    this.playersList.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${p.name}</span><span class="muted">₹${p.purse} cr</span>`;
      this.playersList.appendChild(li);
    });
  }

  renderState(state, selfId) {
    this.setGameId(state?.id);
    const winnerName = state?.winnerId
      ? state.players.find((p) => p.id === state.winnerId)?.name || state.winnerId
      : null;
    this.gameStatus.textContent = state?.winnerId
      ? `Status: ${state?.status ?? "—"} — Winner: ${winnerName}`
      : `Status: ${state?.status ?? "—"}`;
    const cricketer = state?.currentCricketer;
    this.currentName.textContent = cricketer?.name ?? "—";
    this.basePrice.textContent = cricketer ? `${cricketer.basePrice}` : "—";

    const bid = state?.currentBid;
    if (bid) {
      const player = state.players.find((p) => p.id === bid.playerId);
      this.currentBid.textContent = `₹${bid.amount} cr`;
      this.bidder.textContent = player ? `${player.name}` : bid.playerId;
    } else {
      this.currentBid.textContent = "—";
      this.bidder.textContent = "No bids yet";
    }

    this.renderPlayers(state?.players ?? []);
    this.renderSquads(state?.players ?? []);

    const isHost = state?.hostId === selfId;
    this.startBtn.disabled = !isHost || state?.status !== "CREATED";
  }

  renderTimer(timerEndsAt) {
    if (!timerEndsAt) {
      this.timer.textContent = "—";
      return;
    }
    const diff = Math.max(0, Math.round((timerEndsAt - Date.now()) / 1000));
    this.timer.textContent = `${diff.toString().padStart(2, "0")}s`;
  }

  renderSquads(players) {
    this.squads.innerHTML = "";
    players.forEach((p) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <h4>${p.name}</h4>
        <p class="muted tiny">Purse: ₹${p.purse} cr</p>
        <ul>${p.squad
          .map(
            (s) =>
              `<li><span>${s.name}</span><span class="muted tiny">₹${s.soldPrice} cr</span></li>`
          )
          .join("")}</ul>
      `;
      this.squads.appendChild(card);
    });
  }
}

class AuctionApp {
  constructor() {
    this.state = null;
    this.selfId = null;
    this.ui = new AuctionUI();
    const params = new URLSearchParams(window.location.search);
    this.intent = {
      mode: params.get("mode"),
      gameId: params.get("gameId"),
      name: params.get("name") || "Player",
      purse: Number(params.get("purse") || 100)
    };

    const wsUrlBase = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
    const stored = getStoredPlayerId();
    const urlWithId = stored ? `${wsUrlBase}/?playerId=${stored}` : wsUrlBase;
    this.socket = new SocketClient(urlWithId, {
      onOpen: () => this.ui.setConnection("Connected"),
      onClose: () => this.ui.setConnection("Disconnected"),
      onMessage: (msg) => this.handleMessage(msg)
    });

    this.bindForms();
    this.timerInterval = setInterval(() => this.ui.renderTimer(this.state?.timerEndsAt), 500);
  }

  bindForms() {
    document.getElementById("bidForm").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!this.state) return;
      const amount = Number(new FormData(e.target).get("amount"));
      this.socket.send("bid", { gameId: this.state.id, amount });
      e.target.reset();
    });

    this.ui.startBtn.addEventListener("click", () => {
      if (this.state?.id) this.socket.send("start_game", { gameId: this.state.id });
    });

    this.ui.copyCodeBtn.addEventListener("click", async () => {
      if (!this.state?.id) return;
      await navigator.clipboard.writeText(this.state.id);
      this.ui.copyCodeBtn.textContent = "Copied";
      setTimeout(() => (this.ui.copyCodeBtn.textContent = "Copy Code"), 1200);
    });
  }

  bootstrapIntent() {
    if (!this.intent.mode) return;
    if (this.intent.mode === "create") {
      this.socket.send("create_game", {
        name: this.intent.name,
        purse: this.intent.purse
      });
    } else if (this.intent.mode === "join") {
      this.socket.send("join_game", {
        gameId: this.intent.gameId,
        name: this.intent.name,
        purse: this.intent.purse
      });
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "connected":
        this.selfId = msg.playerId;
        storePlayerId(msg.playerId);
        this.bootstrapIntent();
        break;
      case "game_created":
        this.state = { id: msg.gameId };
        this.ui.setGameId(msg.gameId);
        history.replaceState({}, "", `/game.html?mode=join&gameId=${msg.gameId}`);
        break;
      case "player_joined":
        this.notify(`Player joined: ${msg.name}`);
        break;
      case "game_started":
        this.notify("Auction started");
        break;
      case "new_cricketer":
        this.state = { ...(this.state || {}), currentCricketer: msg.cricketer, timerEndsAt: msg.timerEndsAt };
        this.ui.renderTimer(msg.timerEndsAt);
        break;
      case "bid_update":
        this.state = { ...(this.state || {}), currentBid: msg.currentBid, timerEndsAt: msg.timerEndsAt };
        this.ui.renderTimer(msg.timerEndsAt);
        break;
      case "sold":
        if (msg.sold) {
          this.notify(`${msg.cricketer.name} sold for ₹${msg.price} cr`);
        } else {
          this.notify(`${msg.cricketer.name} went unsold`);
        }
        break;
      case "state":
        this.state = msg.game;
        this.ui.renderState(this.state, this.selfId);
        this.ui.renderTimer(this.state?.timerEndsAt);
        break;
      case "game_over":
        this.state = { ...(this.state || {}), winnerId: msg.winnerId || this.state?.winnerId || null };
        this.notify("Auction over");
        this.ui.renderState(this.state, this.selfId);
        break;
      case "winner_declared":
        this.state = { ...(this.state || {}), winnerId: msg.winnerId || null };
        if (msg.winnerId) {
          const winnerName =
            this.state.players?.find((p) => p.id === msg.winnerId)?.name || msg.winnerId;
          this.notify(`Winner: ${winnerName}`);
        } else {
          this.notify("Winner could not be determined", true);
        }
        this.ui.renderState(this.state, this.selfId);
        break;
      case "error":
        this.notify(msg.message || "Error", true);
        break;
      default:
        break;
    }
  }

  notify(text, danger = false) {
    this.ui.connectionStatus.textContent = text;
    this.ui.connectionStatus.style.color = danger ? "#ff9b9b" : "#9bffd1";
  }
}

window.addEventListener("DOMContentLoaded", () => new AuctionApp());

