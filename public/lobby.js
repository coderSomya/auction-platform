function storePlayerId(id) {
  localStorage.setItem("auction_player_id", id);
}

function getPlayerId() {
  return localStorage.getItem("auction_player_id");
}

function redirect(mode, params) {
  const search = new URLSearchParams({ mode, ...params }).toString();
  window.location.href = `/game.html?${search}`;
}

function init() {
  const createForm = document.getElementById("createForm");
  const joinForm = document.getElementById("joinForm");

  createForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(createForm);
    redirect("create", {
      name: fd.get("name"),
      purse: fd.get("purse") || "100"
    });
  });

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(joinForm);
    redirect("join", {
      gameId: (fd.get("gameId") || "").toUpperCase(),
      name: fd.get("name"),
      purse: fd.get("purse") || "100"
    });
  });
}

document.addEventListener("DOMContentLoaded", init);

