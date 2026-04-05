let allFilms = [];

document.addEventListener("DOMContentLoaded", loadFilms);

function loadFilms() {
  chrome.storage.local.get(["seen_films"], (data) => {
    const seen = data.seen_films || {};
    const entries = Object.entries(seen);

    if (!entries.length) {
      showEmpty("no films seen yet. browse netflix to populate this list.");
      return;
    }

    allFilms = entries
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => (parseFloat(b.rating) || -1) - (parseFloat(a.rating) || -1));

    render();
  });
}

function render() {
  const tbody = document.getElementById("films-body");
  const table = document.getElementById("films-table");
  const emptyMsg = document.getElementById("empty-msg");

  tbody.innerHTML = "";
  table.style.display = "table";
  emptyMsg.style.display = "none";

  allFilms.forEach((film, i) => {
    const tr = document.createElement("tr");

    const rankTd = document.createElement("td");
    rankTd.textContent = i + 1;

    const titleTd = document.createElement("td");
    if (film.url) {
      const a = document.createElement("a");
      a.href = film.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = film.title;
      titleTd.appendChild(a);
    } else {
      titleTd.textContent = film.title;
    }

    const yearTd = document.createElement("td");
    yearTd.textContent = film.year || "—";

    const ratingTd = document.createElement("td");
    ratingTd.textContent = film.rating;

    tr.append(rankTd, titleTd, yearTd, ratingTd);
    tbody.appendChild(tr);
  });
}

function showEmpty(msg) {
  document.getElementById("films-table").style.display = "none";
  const el = document.getElementById("empty-msg");
  el.style.display = "block";
  el.textContent = msg;
}
