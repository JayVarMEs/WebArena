"use strict";

/* Convert a portable .charv character.json into the detail shape used by fight.js.
   Keep the stat calculation in sync with vault/serializers.py::stats_detail. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CharvArena = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STAT_KEYS = ["atk", "hp", "mana", "speed", "effectiveness", "effect_resistance"];
  const DEFAULTS = {
    atk: [10, 1], hp: [100, 10], mana: [50, 5], speed: [10, 1],
    effectiveness: [10, 1], effect_resistance: [10, 1],
  };

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return value === null || value === undefined || value === "" || !Number.isFinite(parsed)
      ? fallback : parsed;
  }

  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }

  function characterFromArchive(payload, portraitUrl = null) {
    if (!payload || payload.format !== "charv1" || typeof payload.name !== "string" || !payload.name.trim()) {
      throw new Error("This is not a valid Character Vault .charv character file.");
    }
    const sourceStats = payload.stats || {};
    const level = Math.max(1, Math.trunc(number(sourceStats.level, 1)));
    const stats = { level };
    const levelValues = {};
    const buffs = (Array.isArray(payload.perm_buffs) ? payload.perm_buffs : [])
      .filter((buff) => buff && (buff.enabled === undefined || Boolean(buff.enabled)));
    const defs = payload.item_defs && typeof payload.item_defs === "object" ? payload.item_defs : {};
    const items = (Array.isArray(payload.items) ? payload.items : []).flatMap((instance, index) => {
      if (!instance || typeof instance !== "object") return [];
      const ref = String(instance.item_def_ref ?? "");
      const definition = Object.hasOwn(defs, ref) ? defs[ref] : null;
      if (!definition || typeof definition !== "object") return [];
      const item = { ...definition, kind: ["weapon", "armor", "item"].includes(definition.kind) ? definition.kind : "item" };
      return [{
        id: index + 1, item_def_id: ref, item,
        quantity: item.is_stackable === false ? 1 : Math.max(1, Math.trunc(number(instance.quantity, 1))),
        location: instance.location === "equip" ? "equip" : "bag",
        equip_slot: instance.equip_slot || null,
      }];
    });

    for (const key of STAT_KEYS) {
      const base = number(sourceStats[`base_${key}`], DEFAULTS[key][0]);
      const growth = number(sourceStats[`growth_${key}`], DEFAULTS[key][1]);
      stats[`base_${key}`] = base;
      stats[`growth_${key}`] = growth;
      levelValues[key] = base + growth * (level - 1);
      stats[`current_${key}`] = levelValues[key];
    }

    for (const buff of buffs) {
      const targets = buff.stat === "all" ? STAT_KEYS : String(buff.stat || "").split(",");
      for (const key of targets) {
        if (!STAT_KEYS.includes(key)) continue;
        stats[`current_${key}`] += buff.is_percent
          ? levelValues[key] * number(buff.amount) / 100 : number(buff.amount);
      }
    }

    let resistance = 0;
    for (const instance of items) {
      if (instance.location !== "equip") continue;
      const item = instance.item;
      for (const key of STAT_KEYS) stats[`current_${key}`] += number(item[`bonus_${key}`]);
      resistance += number(item.dmg_reduct_pct);
    }
    for (const buff of buffs) {
      if (String(buff.stat || "").split(",").includes("damage_resistance")) {
        resistance += number(buff.amount);
      }
    }
    const passives = (Array.isArray(payload.passives) ? payload.passives : [])
      .filter((passive) => passive && typeof passive === "object")
      .map((passive, index) => ({ ...passive, id: index + 1,
        enabled: passive.enabled === undefined || Boolean(passive.enabled) }));
    for (const passive of passives) {
      if (!passive.enabled || passive.trigger !== "always" || passive.action !== "add_stat") continue;
      if (passive.stat === "damage_resistance") resistance += number(passive.amount);
      else if (STAT_KEYS.includes(passive.stat)) stats[`current_${passive.stat}`] += number(passive.amount);
    }
    for (const key of STAT_KEYS) stats[`current_${key}`] = Math.max(0, stats[`current_${key}`]);
    stats.damage_resistance_pct = clamp(resistance, 0, 80);

    const portrait = (Array.isArray(payload.images) ? payload.images : []).find((image) => image && image.is_portrait);
    const skills = (Array.isArray(payload.skills) ? payload.skills : [])
      .filter((skill) => skill && typeof skill === "object" && skill.name)
      .map((skill, index) => ({ ...skill, id: index + 1 }));
    return {
      id: 0, name: payload.name.trim(), alias: payload.alias || "",
      race_name: payload.race_name || "", stats, skills, passives, items,
      portrait_url: portraitUrl,
      portrait_thumb_x: number(portrait && portrait.thumb_x, 50),
      portrait_thumb_y: number(portrait && portrait.thumb_y, 50),
      portrait_thumb_zoom: number(portrait && portrait.thumb_zoom, 1),
    };
  }

  return { characterFromArchive };
});
