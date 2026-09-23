"use strict";

/* Static arena shell. Battle rules and rendering stay in ../static/js/fight.js. */
const importedFighters = { A: null, B: null };
const importSerial = { A: 0, B: 0 };
const $ = (id) => document.getElementById(id);
const STAT_LABELS = {
  atk: "Attack", hp: "HP", mana: "Mana", speed: "Speed",
  effectiveness: "Effectiveness", effect_resistance: "Effect resistance",
  damage_resistance: "Damage resistance", gauge: "Attack Bar",
};
const round1 = (n) => Math.round((n ?? 0) * 10) / 10;

function thumbnailValues(source, prefix = "") {
  const value = (key, low, high, fallback) => {
    const raw = source && source[`${prefix}${key}`];
    const n = Number(raw);
    return raw == null || !Number.isFinite(n) ? fallback : Math.max(low, Math.min(high, n));
  };
  return { thumb_x: value("thumb_x", 0, 100, 50), thumb_y: value("thumb_y", 0, 100, 50), thumb_zoom: value("thumb_zoom", 1, 3, 1) };
}

function applyThumbnailStyle(img, source) {
  const crop = thumbnailValues(source);
  img.classList.add("adjustable-thumb");
  img.style.setProperty("--thumb-x", `${crop.thumb_x}%`);
  img.style.setProperty("--thumb-y", `${crop.thumb_y}%`);
  img.style.setProperty("--thumb-zoom", crop.thumb_zoom);
}

function fighterCard(slot) {
  const stats = [
    ["atk", "ATK"], ["speed", "SPD"], ["effectiveness", "EFF"],
    ["effect_resistance", "RES"], ["dmg_resist", "DMG RES"], ["gauge", "ATB"],
  ];
  return `<article class="fighter" id="fighter${slot}">
    <div class="fighter-identity">
      <div class="fighter-portrait"><img alt="" hidden><span class="fighter-portrait-fallback" aria-hidden="true"></span></div>
      <div class="fighter-heading"><span class="fighter-slot">Character ${slot}</span><div class="fighter-name"></div></div>
      <span class="fighter-state-badge">Ready</span>
    </div>
    <div class="bar hp"><div class="bar-fill"></div><span class="bar-label"></span></div>
    <div class="bar mana"><div class="bar-fill"></div><span class="bar-label"></span></div>
    <div class="fighter-stat-grid">${stats.map(([key, label]) =>
      `<div class="fighter-stat" data-fight-stat="${key}"><span>${label}</span><strong></strong><small></small></div>`).join("")}</div>
    <div class="fighter-effect-groups">${[
      ["positive", "Buffs"], ["negative", "Debuffs"], ["cooldown", "Cooldowns"],
    ].map(([kind, label]) => `<section class="fighter-effect-group ${kind === "cooldown" ? "cooldowns" : kind}">
      <div class="fighter-effect-heading"><span>${label}</span><b>0</b></div>
      <div class="fighter-effects" data-effect-kind="${kind}"></div>
    </section>`).join("")}</div>
  </article>`;
}

$("fightCombatants").innerHTML = `${fighterCard("A")}<div class="fight-vs" aria-hidden="true"><span>VS</span></div>${fighterCard("B")}`;

function setStatus(message, error = false) {
  const box = $("arenaStatus");
  box.textContent = message;
  box.classList.toggle("error", error);
}

function mimeForImage(path) {
  const ext = path.split(".").pop().toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || null;
}

async function readCharacterFile(file) {
  if (!/\.(charv|zip)$/i.test(file.name)) throw new Error("Choose a .charv export from Character Vault.");
  if (file.size > 40 * 1024 * 1024) throw new Error("This character file is too large (40 MB limit).");
  if (typeof JSZip === "undefined") throw new Error("The archive reader did not load. Refresh the page and try again.");
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file("character.json");
  if (!entry) throw new Error("The file has no character.json. Export a .charv file from the main app.");
  const json = await entry.async("string");
  if (json.length > 2 * 1024 * 1024) throw new Error("The character sheet is too large to import.");
  let payload;
  try { payload = JSON.parse(json); }
  catch (_) { throw new Error("The character sheet in this file is damaged."); }
  if (!payload || payload.format !== "charv1" || typeof payload.name !== "string" || !payload.name.trim()) {
    throw new Error("This is not a valid Character Vault .charv character file.");
  }

  let portraitUrl = null;
  const portrait = (Array.isArray(payload.images) ? payload.images : [])
    .find((image) => image && image.is_portrait && typeof image.file === "string");
  if (portrait) {
    const mime = mimeForImage(portrait.file);
    const imageEntry = mime && zip.file(portrait.file);
    if (imageEntry) {
      const bytes = await imageEntry.async("uint8array");
      if (bytes.byteLength <= 10 * 1024 * 1024) {
        portraitUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      }
    }
  }
  try { return CharvArena.characterFromArchive(payload, portraitUrl); }
  catch (error) {
    if (portraitUrl) URL.revokeObjectURL(portraitUrl);
    throw error;
  }
}

function showImport(slot, character) {
  const preview = $(`preview${slot}`);
  preview.replaceChildren();
  if (character.portrait_url) {
    const img = document.createElement("img");
    img.src = character.portrait_url;
    img.alt = "";
    preview.append(img);
  } else {
    const initial = document.createElement("span");
    initial.className = "empty-glyph";
    initial.textContent = character.name.charAt(0).toUpperCase();
    preview.append(initial);
  }
  const info = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = character.name;
  const details = document.createElement("small");
  details.textContent = `Level ${character.stats.level} · ${character.race_name || "Character"} · ${character.skills.length} skills`;
  info.append(name, details);
  preview.append(info);
  $(`importSlot${slot}`).classList.add("loaded");
  $("fightStartBtn").disabled = !(importedFighters.A && importedFighters.B);
}

async function importInto(slot, file) {
  if (!file) return;
  const serial = ++importSerial[slot];
  const target = $(`importSlot${slot}`);
  target.setAttribute("aria-busy", "true");
  setStatus(`Reading ${file.name}…`);
  try {
    const detail = await readCharacterFile(file);
    if (serial !== importSerial[slot]) {
      if (detail.portrait_url) URL.revokeObjectURL(detail.portrait_url);
      return;
    }
    const old = importedFighters[slot];
    importedFighters[slot] = detail;
    showImport(slot, detail);
    if (old && old.portrait_url) URL.revokeObjectURL(old.portrait_url);
    setStatus(`${detail.name} is ready for battle.`);
  } catch (error) {
    if (serial === importSerial[slot]) setStatus(error.message || "Could not read this character file.", true);
  } finally {
    if (serial === importSerial[slot]) target.removeAttribute("aria-busy");
  }
}

for (const slot of ["A", "B"]) {
  $(`file${slot}`).addEventListener("change", (event) => {
    importInto(slot, event.target.files[0]);
    event.target.value = "";
  });
  const target = $(`importSlot${slot}`);
  target.addEventListener("dragover", (event) => { event.preventDefault(); target.classList.add("dragging"); });
  target.addEventListener("dragleave", () => target.classList.remove("dragging"));
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    target.classList.remove("dragging");
    importInto(slot, event.dataTransfer.files[0]);
  });
}

$("fightStartBtn").addEventListener("click", () => {
  if (!importedFighters.A || !importedFighters.B) return;
  stopAutoBattle();
  fight = {
    a: buildFighter({ ...importedFighters.A, id: 1 }),
    b: buildFighter({ ...importedFighters.B, id: 2 }),
    over: false, autoMode: false, actor: null, defender: null,
  };
  $("fightLog").replaceChildren();
  $("fightSetup").hidden = true;
  $("fightArena").hidden = false;
  renderFightState();
  fightLog("The fight begins!");
  beginTurn();
  setStatus("");
});

$("fightAutoBtn").addEventListener("click", () => {
  if (fightAutoTimer || (fight && fight.autoMode)) stopAutoBattle();
  else startAutoBattle();
});

$("fightResetBtn").addEventListener("click", () => {
  stopAutoBattle();
  fight = null;
  renderActionPanel(null);
  renderUpcoming();
  $("fightArena").hidden = true;
  $("fightSetup").hidden = false;
  setStatus("Choose different files or start a rematch.");
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

window.addEventListener("beforeunload", () => {
  for (const character of Object.values(importedFighters)) {
    if (character && character.portrait_url) URL.revokeObjectURL(character.portrait_url);
  }
});
