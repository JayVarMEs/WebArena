"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const JSZip = require("../arena/vendor/jszip.min.js");
const { characterFromArchive } = require("../arena/charv.js");

async function main() {
  const payload = {
    format: "charv1", name: "Test Fighter",
    stats: { level: 3, base_atk: 10, growth_atk: 2 },
    perm_buffs: [
      { enabled: true, stat: "atk", amount: 10, is_percent: true },
      { enabled: true, stat: "speed,damage_resistance", amount: 5 },
    ],
    passives: [{ name: "Ward", enabled: true, trigger: "always", action: "add_stat", stat: "damage_resistance", amount: 10 }],
    skills: [{ name: "Strike", type: "damage", value: 4, cooldown: 2 }],
    item_defs: {
      sword: { name: "Sword", kind: "weapon", dmg_mult_pct: 20, dmg_reduct_pct: 25, bonus_atk: 3, crit_chance_pct: 10 },
      flask: { name: "Flask", kind: "item", skill_name: "Drink", skill_type: "heal", skill_value: 8 },
    },
    items: [
      { item_def_ref: "sword", quantity: 1, location: "equip", equip_slot: "mainhand" },
      { item_def_ref: "flask", quantity: 2, location: "bag" },
    ],
  };
  const zipped = await new JSZip().file("character.json", JSON.stringify(payload)).generateAsync({ type: "nodebuffer" });
  const archive = await JSZip.loadAsync(zipped);
  const detail = characterFromArchive(JSON.parse(await archive.file("character.json").async("string")));
  assert.equal(detail.stats.current_atk, 18.4);
  assert.equal(detail.stats.current_speed, 17);
  assert.equal(detail.stats.damage_resistance_pct, 40);

  const sandbox = { thumbnailValues: () => ({ thumb_x: 50, thumb_y: 50, thumb_zoom: 1 }), setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "static", "js", "fight.js"), "utf8"), sandbox);
  const fighter = sandbox.buildFighter(detail);
  assert.equal(fighter.weapon_mult, 20);
  assert.equal(fighter.crit_chance, 10);
  assert.equal(fighter.crit_dmg, 50);
  assert.equal(fighter.skills.find((skill) => skill.name === "Drink").uses_remaining, 2);
  console.log("Arena archive and combat compatibility passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
