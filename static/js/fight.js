"use strict";
/* ---------- fight simulator ---------- */
/* A pure client-side sandbox: nothing here is ever saved back to a character.
   Turn order uses a speed-accumulator (ATB): each fighter gauge fills by their
   Speed every tick, and acts whenever it crosses the threshold — a fighter with
   2x the Speed of their opponent ends up acting roughly twice as often, not
   merely "first," matching PLAN.md's turn-order intent more literally. */

const FIGHT_THRESHOLD = 100;
const EFFECT_DURATION = 3;    // turns a skill-cast buff/debuff lasts before wearing off
const MAX_FIGHT_TURNS = 300;  // safety valve against a runaway Auto-Battle session that never resolves
const MIN_BATTLE_SPEED_RATIO = 0.25; // anti-lock: slows cannot erase a fighter's ability to take turns
let fight = null;
let fightAutoTimer = null;

function buildFighter(charDetail) {
  const st = charDetail.stats;
  // A saved character may legitimately have 0 Speed, but inside the battle sandbox every
  // fighter needs some turn progress. Keeping the battle copy at 1+ also gives later Slow
  // effects a stable baseline from which to calculate their anti-lock floor.
  const battleSpeed = Math.max(1, Number(st.current_speed) || 0);
  const equipped = charDetail.items.filter((i) => i.location === "equip");
  // Equipped gear grants actions as before. Ordinary items grant their configured action
  // while carried in the bag. Their saved quantity becomes per-fight charges: three flasks
  // can be thrown three times, but the real inventory remains untouched when the simulation
  // ends. Group legacy duplicate stacks into one button and one combined charge pool.
  const actionItems = [];
  const carriedByDefinition = new Map();
  for (const inst of charDetail.items) {
    if (!inst.item.skill_name || !inst.item.skill_type) continue;
    if (inst.item.kind !== "item") {
      if (inst.location === "equip") actionItems.push(inst);
      continue;
    }
    if (inst.location !== "bag") continue;
    const quantity = Math.max(1, Number(inst.quantity) || 1);
    const existing = carriedByDefinition.get(inst.item_def_id);
    if (existing) {
      existing.simulator_quantity += quantity;
    } else {
      const grouped = { ...inst, simulator_quantity: quantity };
      carriedByDefinition.set(inst.item_def_id, grouped);
      actionItems.push(grouped);
    }
  }
  const itemSkills = actionItems
    .map((inst) => ({
      // Item-instance ids are unique per owned copy. Prefixing also prevents a collision
      // with numeric character-skill ids in the cooldown/usage maps.
      id: `item-${inst.id}`,
      name: inst.item.skill_name,
      description: inst.item.kind === "item"
        ? `${inst.item.description || inst.item.name} Each carried copy grants one use per fight; saved quantity is never consumed.`
        : `Granted by equipped ${inst.item.name}`,
      type: inst.item.skill_type,
      value: inst.item.skill_value || 0,
      mana_cost: inst.item.skill_mana_cost || 0,
      hp_cost: 0,
      cooldown: inst.item.skill_cooldown || 0,
      duration: inst.item.skill_duration || null,
      target: "enemy",
      buff_stat: inst.item.skill_buff_stat || "atk",
      source_item_name: inst.item.name,
      source_item_kind: inst.item.kind,
      source_item_quantity: inst.simulator_quantity || inst.quantity || 1,
      is_inventory_item_action: inst.item.kind === "item",
      uses_remaining: inst.item.kind === "item" ? (inst.simulator_quantity || inst.quantity || 1) : null,
      uses_max: inst.item.kind === "item" ? (inst.simulator_quantity || inst.quantity || 1) : null,
    }));
  const mainhand = equipped.find((i) => i.equip_slot === "mainhand");
  const offhand = equipped.find((i) => i.equip_slot === "offhand");
  let weaponMult = 0;
  let thorns = 0;
  let critChance = 0;
  let critDmg = 0;
  if (mainhand) { weaponMult += mainhand.item.dmg_mult_pct || 0; thorns += mainhand.item.thorns_pct || 0; }
  if (offhand) { weaponMult += (offhand.item.dmg_mult_pct || 0) * 0.5; thorns += offhand.item.thorns_pct || 0; }
  for (const inst of equipped) {
    if (inst.equip_slot !== "mainhand" && inst.equip_slot !== "offhand") thorns += inst.item.thorns_pct || 0;
    critChance += inst.item.crit_chance_pct || 0;
    critDmg += inst.item.crit_dmg_pct || 0;
  }
  critChance = Math.max(0, Math.min(100, critChance));
  // Gear that grants crit chance but no crit damage still crits for a meaningful +50%.
  if (critChance > 0 && critDmg <= 0) critDmg = 50;
  return {
    id: charDetail.id, name: charDetail.name, portraitUrl: charDetail.portrait_url || null,
    portraitCrop: thumbnailValues(charDetail, "portrait_"),
    maxHp: st.current_hp, hp: st.current_hp,
    maxMana: st.current_mana, mana: st.current_mana,
    atk: st.current_atk, speed: battleSpeed,
    effectiveness: st.current_effectiveness, effect_resistance: st.current_effect_resistance,
    dmg_resist: st.damage_resistance_pct || 0,
    weapon_mult: weaponMult, thorns,
    crit_chance: critChance, crit_dmg: critDmg,
    gauge: 0, battleStartRan: false, defending: false, stunTurns: 0, stunImmuneTurns: 0,
    debuffImmuneTurns: 0, activeEffects: [], cooldowns: {}, freshCooldowns: new Set(), usedThorns: new Set(),
    passiveStacks: {},  // passive id -> times fired this fight (enforces max_stacks)
    skills: [...charDetail.skills, ...itemSkills],
    passives: charDetail.passives.filter((p) => p.enabled),
    baseStats: {
      atk: st.current_atk, speed: battleSpeed,
      effectiveness: st.current_effectiveness, effect_resistance: st.current_effect_resistance,
      dmg_resist: st.damage_resistance_pct || 0,
    },
  };
}

/* Slows are control effects, not a second kind of stun. A fighter always retains at
   least 25% of the Speed they entered battle with (and never less than 1), so even an
   oversized or stacked Speed debuff cannot remove them from the turn cycle. */
function minimumBattleSpeed(actor) {
  const startingSpeed = Number(actor?.baseStats?.speed) || Number(actor?.speed) || 1;
  return Math.max(1, Math.ceil(startingSpeed * MIN_BATTLE_SPEED_RATIO));
}

function effectiveBattleSpeed(actor) {
  return Math.max(minimumBattleSpeed(actor), Number(actor?.speed) || 0);
}

function cappedSpeedReduction(actor, requested) {
  return Math.max(0, Math.min(Math.max(0, requested || 0), actor.speed - minimumBattleSpeed(actor)));
}

function speedFloorNote(actor, requested, appliedReduction) {
  return appliedReduction < Math.max(0, requested || 0)
    ? ` (Speed cannot fall below ${round1(minimumBattleSpeed(actor))})`
    : "";
}

/* Attack Bar manipulation (Epic Seven-style): an instant, non-expiring shift of a
   fighter's ATB gauge, not a timed buff/debuff — it directly changes how soon their
   next turn comes up (or, if pushed past FIGHT_THRESHOLD, grants an immediate extra
   turn once the current action resolves and the turn loop re-checks who's up next). */
function shiftGauge(target, amount) {
  const before = target.gauge;
  target.gauge = Math.max(0, Math.min(150, target.gauge + amount));
  return target.gauge - before;
}

function fightLog(msg) {
  const box = $("fightLog");
  const d = document.createElement("div");
  d.textContent = msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

/* Returns the delta that ACTUALLY landed after clamping (stats floor at 0, damage
   resistance caps at 80). Timed effects store this real delta and reverse exactly it on
   wear-off — reversing the requested amount instead caused permanent stat drift (e.g. a
   -50 Speed debuff on a 30-Speed fighter only removed 30, but wear-off gave back 50,
   leaving the target permanently 20 Speed richer). */
function raiseStat(actor, key, amount) {
  if (!amount) return 0;
  if (key === "hp") {
    const beforeMax = actor.maxHp;
    actor.maxHp = Math.max(0, actor.maxHp + amount);
    const delta = actor.maxHp - beforeMax;
    // A downed fighter stays down: a max-HP buff (or an HP debuff wearing off) must never
    // quietly revive someone at 0 HP.
    if (actor.hp > 0) actor.hp = Math.max(0, Math.min(actor.maxHp, actor.hp + delta));
    return delta;
  } else if (key === "mana") {
    const beforeMax = actor.maxMana;
    actor.maxMana = Math.max(0, actor.maxMana + amount);
    const delta = actor.maxMana - beforeMax;
    actor.mana = Math.max(0, Math.min(actor.maxMana, actor.mana + delta));
    return delta;
  } else if (key === "damage_resistance") {
    const before = actor.dmg_resist;
    actor.dmg_resist = Math.max(0, Math.min(80, actor.dmg_resist + amount));
    return actor.dmg_resist - before;
  } else if (key === "speed") {
    const before = actor.speed;
    actor.speed = Math.max(minimumBattleSpeed(actor), actor.speed + amount);
    return actor.speed - before;
  } else if (key in actor) {
    const before = actor[key];
    actor[key] = Math.max(0, actor[key] + amount);
    return actor[key] - before;
  }
  return 0;
}

/* Skill-cast buffs/debuffs wear off after `duration` (default EFFECT_DURATION) of the
   affected fighter's own turns — passives and permanent buffs are unaffected, those
   stay permanent for the fight as before. The stored `amount` is the clamped delta
   raiseStat actually applied, so wear-off reverses exactly what happened. */
function applyTimedEffect(target, key, amount, label, duration = EFFECT_DURATION) {
  const applied = raiseStat(target, key, amount);
  target.activeEffects.push({ stat: key, amount: applied, turnsLeft: duration, label });
  return applied;
}

/* Bleed/Poison: a damage-over-time effect that ticks for `amountPerTurn` on each of the
   target's own turns instead of applying/reversing a stat change — mechanically identical
   between the two, distinguished only by name/flavor (and pill color) in the UI. */
function applyDotEffect(target, amountPerTurn, label, duration = EFFECT_DURATION) {
  target.activeEffects.push({ kind: "dot", amount: amountPerTurn, turnsLeft: duration, label });
}

/* A debuff-family skill (Debuff/Bleed/Poison/Slow) is blocked outright while the target is
   under an Immunity skill's protection — Stun has its own separate grace-period immunity
   (see stunImmuneTurns) and is deliberately unaffected by this one. */
function blockedByDebuffImmunity(actor, target, skill) {
  if (target.debuffImmuneTurns > 0) {
    fightLog(`${actor.name} uses ${skill.name}, but ${target.name} is immune to debuffs and resists!`);
    return true;
  }
  return false;
}

function tickTurnStart(actor) {
  const remaining = [];
  for (const eff of actor.activeEffects) {
    if (eff.kind === "dot") {
      const dmg = Math.max(1, Math.round(eff.amount));
      actor.hp = Math.max(0, actor.hp - dmg);
      fightLog(`${actor.name} takes ${dmg} ${eff.label} damage.`);
      if (actor.hp <= 0) fightLog(`${actor.name} is down!`);
    }
    eff.turnsLeft -= 1;
    if (eff.turnsLeft <= 0) {
      if (eff.kind !== "dot") raiseStat(actor, eff.stat, -eff.amount);
      fightLog(`${actor.name}'s ${eff.label} wears off.`);
    } else {
      remaining.push(eff);
    }
  }
  actor.activeEffects = remaining;

  if (actor.debuffImmuneTurns > 0) {
    actor.debuffImmuneTurns -= 1;
    if (actor.debuffImmuneTurns === 0) fightLog(`${actor.name}'s debuff immunity fades.`);
  }

  // A cooldown set THIS turn (fresh) skips its first tick — without this, ticking at the
  // start of the very next turn made a 1-turn cooldown expire before it ever blocked anything.
  for (const id of Object.keys(actor.cooldowns)) {
    if (actor.freshCooldowns.has(id)) { actor.freshCooldowns.delete(id); continue; }
    actor.cooldowns[id] -= 1;
    if (actor.cooldowns[id] <= 0) delete actor.cooldowns[id];
  }
}

function applyPassiveEffect(actor, other, p, dmgTaken) {
  switch (p.action) {
    case "heal_hp": {
      const before = actor.hp;
      actor.hp = Math.min(actor.maxHp, actor.hp + p.amount);
      if (actor.hp !== before) fightLog(`${actor.name}'s ${p.name} heals ${round1(actor.hp - before)} HP.`);
      break;
    }
    case "restore_mana": {
      const before = actor.mana;
      actor.mana = Math.min(actor.maxMana, actor.mana + p.amount);
      if (actor.mana !== before) fightLog(`${actor.name}'s ${p.name} restores ${round1(actor.mana - before)} mana.`);
      break;
    }
    case "add_stat":
      if (p.stat === "gauge") {
        const delta = shiftGauge(actor, p.amount);
        if (delta) fightLog(`${actor.name}'s ${p.name} shifts their attack bar by ${round1(delta)}.`);
      } else if (p.stat) {
        raiseStat(actor, p.stat, p.amount);
        fightLog(`${actor.name}'s ${p.name} raises ${STAT_LABELS[p.stat] || p.stat} by ${p.amount}.`);
      }
      break;
    case "reflect_damage":
      if (dmgTaken) {
        const reflect = Math.max(1, Math.round((dmgTaken * p.amount) / 100));
        other.hp = Math.max(0, other.hp - reflect);
        fightLog(`${actor.name}'s ${p.name} reflects ${reflect} damage to ${other.name}.`);
        if (other.hp <= 0) fightLog(`${other.name} is down!`);
      }
      break;
    case "counter_attack":
      // isCounter=true on the nested dealDamage call: a counter must not itself
      // trigger reactive (damage_taken) passives, or two counter-attack fighters
      // would volley an infinite chain of counters into each other.
      if (dmgTaken && other.hp > 0) {
        fightLog(`${actor.name}'s ${p.name} triggers a counter-attack!`);
        dealDamage(actor, other, p.amount || 0, "Counter-attack", true);
      }
      break;
    default:
      break; // flavor: no mechanical effect
  }
}

/* Central gate for every in-fight passive fire: respects max_stacks (a per-fight cap on
   how many times a repeating trigger may fire — reins in the otherwise infinite
   turn_start/damage_taken add_stat snowball). max_stacks null/0 = unlimited. */
function firePassive(actor, other, p, dmgTaken) {
  if (p.max_stacks) {
    const used = actor.passiveStacks[p.id] || 0;
    if (used >= p.max_stacks) return;
    actor.passiveStacks[p.id] = used + 1;
    if (used + 1 === p.max_stacks) {
      applyPassiveEffect(actor, other, p, dmgTaken);
      fightLog(`${actor.name}'s ${p.name} reaches its limit (${p.max_stacks} stacks).`);
      return;
    }
  }
  applyPassiveEffect(actor, other, p, dmgTaken);
}

function runSimplePassives(actor, other, trigger) {
  for (const p of actor.passives) {
    if (p.trigger === trigger) firePassive(actor, other, p);
  }
}

function computeDamage(attacker, target, skillValue) {
  let raw = (attacker.atk + (skillValue || 0)) *
    (1 + attacker.weapon_mult / 100) * (1 - Math.min(80, target.dmg_resist) / 100);
  if (target.defending) raw *= 0.5;
  return Math.max(1, Math.round(raw));
}

/* Effectiveness vs Effect Resistance is a landing gate, not a magnitude multiplier:
   - eff < res  → the debuff/DoT/slow fails outright (fully resisted)
   - eff >= res → the effect lands at exactly the value written on the skill
   This keeps battle previews and authored values trustworthy. A target buffing its own
   Speed cannot turn a listed -30 Slow into -60. Self-demerits skip the gate entirely. */
function isResisted(actor, target) {
  return actor.effectiveness < target.effect_resistance;
}

function computeLandedEffectMagnitude(actor, target, rawValue) {
  if (isResisted(actor, target)) return 0;
  return Math.max(0, Number(rawValue) || 0);
}

function computeDebuffMagnitude(actor, target, skill) {
  return computeLandedEffectMagnitude(actor, target, skill.value);
}

function logResisted(actor, target, skill) {
  fightLog(`${actor.name} uses ${skill.name}, but ${target.name}'s Effect Resistance is too high — no effect!`);
}

/* isCounter=true skips the target's own damage_taken passives (including further
   counter-attacks) — without this, two counter-attack fighters would volley an
   infinite chain of counters back and forth. Thorns still applies either way since
   it's a flat reflect, not a recursive dealDamage call, so it can't chain forever. */
function dealDamage(attacker, target, skillValue, label, isCounter) {
  let dmg = computeDamage(attacker, target, skillValue);
  // Crit comes entirely from equipped gear (see buildFighter): no crit gear = 0% chance.
  // Rolled here — not in computeDamage — so AI lethal checks and previews stay on the
  // guaranteed non-crit number.
  let crit = false;
  if (attacker.crit_chance > 0 && Math.random() * 100 < attacker.crit_chance) {
    crit = true;
    dmg = Math.max(1, Math.round(dmg * (1 + attacker.crit_dmg / 100)));
  }
  target.hp = Math.max(0, target.hp - dmg);
  fightLog(`${attacker.name}'s ${label} ${crit ? "CRITS" : "hits"} ${target.name} for ${dmg}${crit ? ` (+${round1(attacker.crit_dmg)}% crit)` : ""}${target.defending ? " (defending)" : ""}.`);
  if (target.hp <= 0) fightLog(`${target.name} is down!`);
  if (target.thorns > 0) {
    const reflect = Math.max(1, Math.round((dmg * target.thorns) / 100));
    attacker.hp = Math.max(0, attacker.hp - reflect);
    fightLog(`${target.name}'s thorns reflect ${reflect} damage to ${attacker.name}.`);
    if (attacker.hp <= 0) fightLog(`${attacker.name} is down!`);
  }
  if (!isCounter) {
    for (const p of target.passives) {
      if (p.trigger === "damage_taken") firePassive(target, attacker, p, dmg);
    }
  }
}

/* Normalizes a skill's up-to-two secondary-effect slots into plain objects the engine can
   loop over. Each slot gets a distinct `label` so its timed effect / anti-stack bookkeeping
   in activeEffects never collides with the other slot's (both would otherwise share the
   skill's name). timing: "before" resolves ahead of the primary damage — that's what lets
   a self Attack buff boost the very hit that carries it. */
function skillEffectSlots(skill) {
  const slots = [];
  for (const [prefix, suffix] of [["effect", ""], ["effect2", " (2)"]]) {
    if (!skill[prefix + "_type"]) continue;
    slots.push({
      type: skill[prefix + "_type"],
      stat: skill[prefix + "_stat"],
      value: skill[prefix + "_value"] || 0,
      target: skill[prefix + "_target"],
      duration: skill[prefix + "_duration"],
      timing: skill[prefix + "_timing"] === "before" ? "before" : "after",
      label: skill.name + suffix,
    });
  }
  return slots;
}

/* The HP sacrifice demerit is paid at the END of the caster's turn, after the skill fully
   resolves — the "dramatic final attack": the hit always lands first, and only then does
   the price come due, possibly downing the caster (or both fighters, for a draw). */
function payHpCost(actor, skill) {
  const cost = skill.hp_cost || 0;
  if (!cost) return;
  actor.hp = Math.max(0, actor.hp - cost);
  fightLog(`${actor.name} sacrifices ${round1(cost)} HP to fuel ${skill.name}.`);
  if (actor.hp <= 0) fightLog(`${actor.name} collapses from the sacrifice — a true final attack!`);
}

function skillHasUses(skill) {
  return !skill.is_inventory_item_action || (skill.uses_remaining || 0) > 0;
}

function spendSkillUse(actor, skill) {
  if (!skill.is_inventory_item_action) return;
  skill.uses_remaining = Math.max(0, (skill.uses_remaining || 0) - 1);
  const remaining = skill.uses_remaining;
  fightLog(`${actor.name} has ${remaining} ${skill.source_item_name} use${remaining === 1 ? "" : "s"} left this fight.`);
}

function castSkill(actor, target, skill) {
  actor.mana = Math.max(0, actor.mana - (skill.mana_cost || 0));
  spendSkillUse(actor, skill);
  // A final item charge needs no cooldown because it cannot be used again this fight.
  // Earlier charges use the item definition's editable cooldown just like a normal skill.
  if (skill.id != null && skill.cooldown && skillHasUses(skill)) {
    actor.cooldowns[skill.id] = skill.cooldown;
    actor.freshCooldowns.add(String(skill.id));  // Object.keys() yields strings — match that
  }
  const effects = skillEffectSlots(skill);
  for (const eff of effects) {
    if (eff.timing === "before") applyEffectSlot(actor, target, skill, eff);
  }
  switch (skill.type) {
    case "heal": {
      const before = actor.hp;
      actor.hp = Math.min(actor.maxHp, actor.hp + skill.value);
      fightLog(`${actor.name} uses ${skill.name}, healing ${round1(actor.hp - before)} HP.`);
      break;
    }
    case "buff": {
      const key = skill.buff_stat || "atk";
      if (key === "gauge") {
        const delta = shiftGauge(actor, skill.value);
        fightLog(`${actor.name} uses ${skill.name}, advancing their attack bar by ${round1(delta)}.`);
      } else {
        const duration = skill.duration || EFFECT_DURATION;
        applyTimedEffect(actor, key, skill.value, skill.name, duration);
        fightLog(`${actor.name} uses ${skill.name}, raising ${STAT_LABELS[key] || key} by ${skill.value} for ${duration} turns.`);
      }
      break;
    }
    case "debuff": {
      const selfDemerit = skill.target === "self";
      const victim = selfDemerit ? actor : target;
      if (!selfDemerit && blockedByDebuffImmunity(actor, target, skill)) break;
      if (!selfDemerit && isResisted(actor, target)) { logResisted(actor, target, skill); break; }
      const key = skill.buff_stat || "atk";
      // a self-inflicted demerit is a guaranteed cost, not a resisted effect landed on an opponent
      const magnitude = selfDemerit ? (skill.value || 0) : computeDebuffMagnitude(actor, target, skill);
      const victimLabel = selfDemerit ? "their own" : `${victim.name}'s`;
      if (key === "gauge") {
        const delta = shiftGauge(victim, -magnitude);
        fightLog(`${actor.name} uses ${skill.name}, pulling back ${victimLabel} attack bar by ${round1(-delta)}.`);
      } else {
        const duration = skill.duration || EFFECT_DURATION;
        const applied = applyTimedEffect(victim, key, -magnitude, skill.name, duration);
        const reduction = Math.abs(applied);
        const floorNote = key === "speed" ? speedFloorNote(victim, magnitude, reduction) : "";
        fightLog(`${actor.name} uses ${skill.name}, lowering ${victimLabel} ${STAT_LABELS[key] || key} by ${round1(reduction)} for ${duration} turns${floorNote}.`);
      }
      break;
    }
    case "bleed":
    case "poison": {
      if (blockedByDebuffImmunity(actor, target, skill)) break;
      if (isResisted(actor, target)) { logResisted(actor, target, skill); break; }
      const magnitude = computeDebuffMagnitude(actor, target, skill);
      const duration = skill.duration || EFFECT_DURATION;
      applyDotEffect(target, magnitude, skill.name, duration);
      fightLog(`${actor.name} uses ${skill.name}, afflicting ${target.name} with ${round1(magnitude)} ${skill.type} damage per turn for ${duration} turns.`);
      break;
    }
    case "slow": {
      if (blockedByDebuffImmunity(actor, target, skill)) break;
      if (isResisted(actor, target)) { logResisted(actor, target, skill); break; }
      const magnitude = computeDebuffMagnitude(actor, target, skill);
      const duration = skill.duration || EFFECT_DURATION;
      const applied = applyTimedEffect(target, "speed", -magnitude, skill.name, duration);
      const reduction = Math.abs(applied);
      fightLog(`${actor.name} uses ${skill.name}, slowing ${target.name}'s Speed by ${round1(reduction)} for ${duration} turns${speedFloorNote(target, magnitude, reduction)}.`);
      break;
    }
    case "immunity": {
      const turns = Math.max(1, Math.round(skill.value) || 1);
      actor.debuffImmuneTurns = Math.max(actor.debuffImmuneTurns || 0, turns);
      fightLog(`${actor.name} uses ${skill.name}, becoming immune to debuffs for ${turns} turn${turns === 1 ? "" : "s"}.`);
      break;
    }
    case "thorns":
      actor.thorns += skill.value;
      if (skill.id != null) actor.usedThorns.add(skill.id);
      fightLog(`${actor.name} uses ${skill.name}, gaining ${skill.value}% thorns for the fight.`);
      break;
    case "stun": {
      // A target who just broke free of a stun gets one guaranteed real turn before
      // they can be stunned again — without this, a cheap enough (low cooldown/cost)
      // stun skill could chain-lock an opponent out of ever acting for the whole fight.
      if (target.stunImmuneTurns > 0) {
        fightLog(`${actor.name} uses ${skill.name}, but ${target.name} just broke free and resists!`);
        break;
      }
      const turns = Math.max(1, Math.round(skill.value) || 1);
      target.stunTurns = Math.max(target.stunTurns || 0, turns);
      fightLog(`${actor.name} uses ${skill.name}, stunning ${target.name} for ${turns} turn${turns === 1 ? "" : "s"}.`);
      break;
    }
    default:
      dealDamage(actor, target, skill.value || 0, skill.name);
      break;
  }
  for (const eff of effects) {
    if (eff.timing !== "before") applyEffectSlot(actor, target, skill, eff);
  }
  payHpCost(actor, skill);
}

/* One secondary status-effect slot layered on top of a skill's primary action -- server-side
   validation only ever allows effect slots on a type:"damage" skill, so plain damage never
   blocks (no immunity/resist check could have stopped the primary hit the way it could for a
   primary stun/debuff). Examples: "attack for 10, and buff own Attack for 2 turns" or
   "attack for 50, but Poison self as a demerit." Called once per filled slot, either before
   or after the primary damage depending on the slot's timing. */
function applyEffectSlot(actor, target, skill, eff) {
  const effType = eff.type;
  const duration = eff.duration || EFFECT_DURATION;
  // without this, a compound skill recast every turn it's off cooldown would stack its
  // secondary buff/DoT indefinitely -- this skill "type" is "damage", so it never passes
  // through the AI's existing already-active buff/debuff throttles the way a standalone
  // buff/debuff skill does
  const alreadyActiveOn = (who) => who.activeEffects.some((e) => e.label === eff.label);

  if (effType === "buff") {
    if (alreadyActiveOn(actor)) return;
    const key = eff.stat || "atk";
    if (key === "gauge") {
      const delta = shiftGauge(actor, eff.value);
      fightLog(`${actor.name}'s ${skill.name} also advances their attack bar by ${round1(delta)}.`);
    } else {
      applyTimedEffect(actor, key, eff.value, eff.label, duration);
      fightLog(`${actor.name}'s ${skill.name} also raises their ${STAT_LABELS[key] || key} by ${round1(eff.value)} for ${duration} turns.`);
    }
    return;
  }

  const selfDemerit = eff.target === "self";
  const victim = selfDemerit ? actor : target;
  if (effType === "stun") {
    if (!selfDemerit && victim.stunImmuneTurns > 0) {
      fightLog(`${actor.name}'s ${skill.name} deals damage, but ${victim.name} just broke free and resists the Stun.`);
      return;
    }
    const turns = Math.max(1, Math.round(eff.value) || 1);
    victim.stunTurns = Math.max(victim.stunTurns || 0, turns);
    fightLog(`${actor.name}'s ${skill.name} also stuns ${selfDemerit ? "themself" : victim.name} for ${turns} turn${turns === 1 ? "" : "s"}.`);
    return;
  }
  if (!selfDemerit && blockedByDebuffImmunity(actor, target, skill)) return;
  if (!selfDemerit && isResisted(actor, target)) {
    fightLog(`${actor.name}'s ${skill.name} secondary effect fizzles — ${target.name}'s Effect Resistance is too high.`);
    return;
  }
  if (alreadyActiveOn(victim)) return;
  // a self-inflicted demerit is a guaranteed, unscaled cost -- not a resisted effect landed
  // on an opponent (mirrors the primary self-demerit debuff path above)
  const magnitude = selfDemerit ? (eff.value || 0) : computeLandedEffectMagnitude(actor, target, eff.value);
  const victimLabel = selfDemerit ? "their own" : `${victim.name}'s`;

  if (effType === "slow") {
    const applied = applyTimedEffect(victim, "speed", -magnitude, eff.label, duration);
    const reduction = Math.abs(applied);
    fightLog(`${actor.name}'s ${skill.name} also slows ${victimLabel} Speed by ${round1(reduction)} for ${duration} turns${speedFloorNote(victim, magnitude, reduction)}.`);
  } else if (effType === "bleed" || effType === "poison") {
    applyDotEffect(victim, magnitude, eff.label, duration);
    fightLog(`${actor.name}'s ${skill.name} also afflicts ${selfDemerit ? "themself" : victim.name} with ${round1(magnitude)} ${effType} damage per turn for ${duration} turns.`);
  } else if (effType === "debuff") {
    const key = eff.stat || "atk";
    if (key === "gauge") {
      const delta = shiftGauge(victim, -magnitude);
      fightLog(`${actor.name}'s ${skill.name} also pulls back ${victimLabel} attack bar by ${round1(-delta)}.`);
    } else {
      const applied = applyTimedEffect(victim, key, -magnitude, eff.label, duration);
      const reduction = Math.abs(applied);
      const floorNote = key === "speed" ? speedFloorNote(victim, magnitude, reduction) : "";
      fightLog(`${actor.name}'s ${skill.name} also lowers ${victimLabel} ${STAT_LABELS[key] || key} by ${round1(reduction)} for ${duration} turns${floorNote}.`);
    }
  }
}

/* AI priority: (1) finish the fight this turn if at all possible — cheapest
   lethal option, no point overspending mana on overkill; (2) survive — heal
   if hurt and able, otherwise Defend rather than trade blows recklessly;
   (3) stun the opponent to buy a free turn, if they aren't already stunned or
   still immune from having just broken free; (4) build up with a fresh self
   buff, then a fresh self Immunity if not already protected, then a
   not-yet-used thorns skill, if nothing more urgent is happening; (5) if the
   opponent hits noticeably harder and isn't shrugging off debuffs, wear their
   offense (or their HP, via Bleed/Poison/Slow) down instead of just racing
   damage; (6) otherwise hit as hard as affordable. Respects mana cost and
   cooldowns throughout. */
function chooseAction(actor) {
  const other = actor === fight.a ? fight.b : fight.a;
  const usable = (s) => skillHasUses(s) &&
    (s.mana_cost || 0) <= actor.mana && !actor.cooldowns[s.id];

  const lethal = [];
  if (computeDamage(actor, other, 0) >= other.hp) lethal.push({ kind: "basic", cost: 0 });
  for (const s of actor.skills.filter((s) => s.type === "damage" && usable(s))) {
    if (computeDamage(actor, other, s.value || 0) >= other.hp) lethal.push({ kind: "skill", skill: s, cost: s.mana_cost || 0 });
  }
  if (lethal.length) {
    lethal.sort((a, b) => a.cost - b.cost);
    const pick = lethal[0];
    return pick.kind === "basic" ? { kind: "basic" } : { kind: "skill", skill: pick.skill };
  }

  if (actor.hp <= actor.maxHp * 0.3) {
    const heals = actor.skills.filter((s) => s.type === "heal" && usable(s) && actor.hp < actor.maxHp);
    if (heals.length) return { kind: "skill", skill: heals.reduce((a, b) => (b.value > a.value ? b : a)) };
    return { kind: "defend" };
  }

  if (!(other.stunTurns > 0) && !(other.stunImmuneTurns > 0)) {
    const stuns = actor.skills.filter((s) => s.type === "stun" && usable(s));
    if (stuns.length) return { kind: "skill", skill: stuns.reduce((a, b) => (b.value > a.value ? b : a)) };
  }

  // Non-gauge buffs are only "fresh" while not already active (they naturally become
  // pickable again once they wear off); gauge buffs are instant so they're excluded here
  // to avoid the AI stalling on tempo instead of ever attacking. Thorns is a one-time
  // permanent boost per skill (usedThorns), not something worth recasting every turn.
  const freshBuffs = actor.skills.filter((s) => s.type === "buff" && s.buff_stat !== "gauge" &&
    usable(s) && !actor.activeEffects.some((e) => e.label === s.name));
  if (freshBuffs.length) return { kind: "skill", skill: freshBuffs.reduce((a, b) => (b.value > a.value ? b : a)) };

  if (!(actor.debuffImmuneTurns > 0)) {
    const freshImmunity = actor.skills.filter((s) => s.type === "immunity" && usable(s));
    if (freshImmunity.length) return { kind: "skill", skill: freshImmunity.reduce((a, b) => (b.value > a.value ? b : a)) };
  }

  const freshThorns = actor.skills.filter((s) => s.type === "thorns" && usable(s) && !actor.usedThorns.has(s.id));
  if (freshThorns.length) return { kind: "skill", skill: freshThorns.reduce((a, b) => (b.value > a.value ? b : a)) };

  // isResisted: no point casting a debuff the difference-formula guarantees will fizzle
  if (other.atk > actor.atk * 1.3 && !(other.debuffImmuneTurns > 0) && !isResisted(actor, other)) {
    // self-demerit debuffs (target: self) are a deliberate, purely-costly roleplay option —
    // never something the "wear the opponent down" heuristic should pick on its own
    const debuffs = actor.skills.filter((s) => ["debuff", "bleed", "poison", "slow"].includes(s.type) &&
      s.target !== "self" && usable(s) && !other.activeEffects.some((e) => e.label === s.name));
    if (debuffs.length) return { kind: "skill", skill: debuffs.reduce((a, b) => (b.value > a.value ? b : a)) };
  }

  // HP-sacrifice skills are always castable, but the AI only spends HP it can spare here —
  // a cast that would down the caster is reserved for the lethal-finisher check above
  // (where a dramatic "take them down with me" final attack is exactly the point).
  const damages = actor.skills.filter((s) => s.type === "damage" && usable(s) && (s.hp_cost || 0) < actor.hp);
  if (damages.length) return { kind: "skill", skill: damages.reduce((a, b) => (b.value > a.value ? b : a)) };
  return { kind: "basic" };
}

function advanceGauges() {
  const speedA = effectiveBattleSpeed(fight.a);
  const speedB = effectiveBattleSpeed(fight.b);
  while (fight.a.gauge < FIGHT_THRESHOLD && fight.b.gauge < FIGHT_THRESHOLD) {
    fight.a.gauge += speedA;
    fight.b.gauge += speedB;
  }
}

function nextActor() {
  advanceGauges();
  if (fight.a.gauge >= FIGHT_THRESHOLD && fight.b.gauge >= FIGHT_THRESHOLD) {
    return effectiveBattleSpeed(fight.a) >= effectiveBattleSpeed(fight.b) ? fight.a : fight.b; // tie -> Character A
  }
  return fight.a.gauge >= FIGHT_THRESHOLD ? fight.a : fight.b;
}

function checkFightEnd() {
  if (fight.a.hp > 0 && fight.b.hp > 0) return false;
  fight.over = true;
  if (fight.a.hp <= 0 && fight.b.hp <= 0) fightLog("Both fighters are down — it's a draw!");
  else fightLog(`${fight.a.hp > 0 ? fight.a.name : fight.b.name} wins the fight!`);
  stopAutoBattle();
  renderFightState();
  renderActionPanel(null);
  renderUpcoming();
  return true;
}

/* Non-destructive lookahead: replays the ATB gauge math on local copies so it
   can preview whose turns are coming up without touching the real fight state. */
function predictUpcoming(count) {
  let gaugeA = fight.a.gauge;
  let gaugeB = fight.b.gauge;
  const speedA = effectiveBattleSpeed(fight.a);
  const speedB = effectiveBattleSpeed(fight.b);
  const order = [];
  for (let i = 0; i < count; i++) {
    while (gaugeA < FIGHT_THRESHOLD && gaugeB < FIGHT_THRESHOLD) {
      gaugeA += speedA;
      gaugeB += speedB;
    }
    const isA = gaugeA >= FIGHT_THRESHOLD && gaugeB >= FIGHT_THRESHOLD ? speedA >= speedB : gaugeA >= FIGHT_THRESHOLD;
    if (isA) gaugeA -= FIGHT_THRESHOLD; else gaugeB -= FIGHT_THRESHOLD;
    order.push(isA ? fight.a.name : fight.b.name);
  }
  return order;
}

function renderUpcoming() {
  const el = $("fightUpcoming");
  if (!fight || fight.over) { el.textContent = ""; return; }
  el.textContent = "Up next: " + predictUpcoming(3).join(" → ");
}

function performAction(actor, other, action) {
  if (action.kind === "skill") castSkill(actor, other, action.skill);
  else if (action.kind === "defend") {
    actor.defending = true;
    fightLog(`${actor.name} braces for the next hit, halving damage taken until their next turn.`);
  } else {
    dealDamage(actor, other, 0, "Basic Attack");
  }
}

/* Starts (or re-shows) the current actor's turn: resolves start-of-battle/turn
   passives, then either lets the player choose an action or — in Auto-Battle
   mode — has the AI decide after a short pacing delay. */
function beginTurn() {
  if (!fight || fight.over) return;
  fight.turnCount = (fight.turnCount || 0) + 1;
  if (fight.turnCount > MAX_FIGHT_TURNS) {
    fight.over = true;
    fightLog(`Called as a draw — ${MAX_FIGHT_TURNS} turns with no resolution.`);
    stopAutoBattle();
    renderFightState();
    renderActionPanel(null);
    renderUpcoming();
    return;
  }

  const actor = nextActor();
  const other = actor === fight.a ? fight.b : fight.a;
  actor.gauge -= FIGHT_THRESHOLD;
  actor.defending = false;
  fight.actor = actor;
  fight.defender = other;
  tickTurnStart(actor);
  if (checkFightEnd()) return;

  if (!actor.battleStartRan) { runSimplePassives(actor, other, "battle_start"); actor.battleStartRan = true; }
  if (!other.battleStartRan) { runSimplePassives(other, actor, "battle_start"); other.battleStartRan = true; }
  if (checkFightEnd()) return;

  runSimplePassives(actor, other, "turn_start");
  if (checkFightEnd()) return;

  // "Below 50% HP" passives: checked at the start of the fighter's own turn, once per
  // qualifying turn — pair with Max stacks for a once-per-fight desperation move.
  if (actor.hp > 0 && actor.hp < actor.maxHp * 0.5) {
    runSimplePassives(actor, other, "hp_below_half");
    if (checkFightEnd()) return;
  }

  if (actor.stunTurns > 0) {
    actor.stunTurns -= 1;
    if (actor.stunTurns === 0) actor.stunImmuneTurns = 1;  // guaranteed real turn before they can be stunned again
    fightLog(`${actor.name} is stunned and can't act!`);
    renderFightState();
    renderUpcoming();
    renderActionPanel(null);
    if (fight.autoMode) {
      fightAutoTimer = setTimeout(() => {
        if (!fight || fight.over || !fight.autoMode) return;
        beginTurn();
      }, 350);
    } else {
      beginTurn();
    }
    return;
  }
  actor.stunImmuneTurns = 0;  // they're acting for real this turn — grace period spent

  renderFightState();
  renderUpcoming();

  if (fight.autoMode) {
    renderActionPanel(null);
    fightAutoTimer = setTimeout(() => {
      if (!fight || fight.over || !fight.autoMode) return;
      chooseAndResolve(actor, chooseAction(actor));
    }, 350);
  } else {
    renderActionPanel(actor);
  }
}

function chooseAndResolve(actor, action) {
  if (!fight || fight.over) return;
  // Derive the opponent from the fighter taking this action. This keeps self-only
  // buffs isolated even if an old UI callback somehow survives into a later turn.
  const other = actor === fight.a ? fight.b : fight.a;
  performAction(actor, other, action);
  if (checkFightEnd()) return;
  renderFightState();
  beginTurn();
}

/* Preview text shown under each action button — the whole point is the
   player can see roughly what an action will do before committing to it. */
function skillPreview(actor, other, skill) {
  let base;
  switch (skill.type) {
    case "heal": {
      const amount = Math.max(0, Math.min(actor.maxHp - actor.hp, skill.value || 0));
      base = `heals ≈ ${round1(amount)} HP`;
      break;
    }
    case "buff": {
      const key = skill.buff_stat || "atk";
      base = key === "gauge"
        ? `+${round1(skill.value)} attack bar (self, instant)`
        : `+${round1(skill.value)} ${STAT_LABELS[key] || key} (self, ${skill.duration || EFFECT_DURATION}t)`;
      break;
    }
    case "debuff": {
      const selfDemerit = skill.target === "self";
      if (!selfDemerit && isResisted(actor, other)) { base = `no effect — ${other.name}'s Effect Res beats your Effectiveness`; break; }
      const key = skill.buff_stat || "atk";
      const magnitude = selfDemerit ? (skill.value || 0) : computeDebuffMagnitude(actor, other, skill);
      const who = selfDemerit ? "self" : other.name;
      const victim = selfDemerit ? actor : other;
      const shownReduction = key === "speed" ? cappedSpeedReduction(victim, magnitude) : magnitude;
      const floorHint = key === "speed" && shownReduction < magnitude
        ? `, floor ${round1(minimumBattleSpeed(victim))}` : "";
      base = key === "gauge"
        ? `-${round1(magnitude)} attack bar to ${who} (instant)`
        : `-${round1(shownReduction)} ${STAT_LABELS[key] || key} to ${who} (${skill.duration || EFFECT_DURATION}t${floorHint})`;
      break;
    }
    case "thorns":
      base = `+${round1(skill.value)}% thorns (self)`;
      break;
    case "stun": {
      const turns = Math.max(1, Math.round(skill.value) || 1);
      base = `stuns ${other.name} for ${turns} turn${turns === 1 ? "" : "s"}`;
      break;
    }
    case "bleed":
    case "poison": {
      if (isResisted(actor, other)) { base = `no effect — ${other.name}'s Effect Res beats your Effectiveness`; break; }
      const magnitude = computeDebuffMagnitude(actor, other, skill);
      base = `≈ ${round1(magnitude)} dmg/turn ${skill.type} to ${other.name} (${skill.duration || EFFECT_DURATION}t)`;
      break;
    }
    case "slow": {
      if (isResisted(actor, other)) { base = `no effect — ${other.name}'s Effect Res beats your Effectiveness`; break; }
      const magnitude = computeDebuffMagnitude(actor, other, skill);
      const reduction = cappedSpeedReduction(other, magnitude);
      const floorHint = reduction < magnitude ? `, floor ${round1(minimumBattleSpeed(other))}` : "";
      base = `-${round1(reduction)} Speed to ${other.name} (${skill.duration || EFFECT_DURATION}t${floorHint})`;
      break;
    }
    case "immunity": {
      const turns = Math.max(1, Math.round(skill.value) || 1);
      base = `immune to debuffs for ${turns} turn${turns === 1 ? "" : "s"} (self)`;
      break;
    }
    default: {
      // a "before the hit" self Attack buff boosts this very attack — fold it into the
      // estimate (adding to skillValue is equivalent to adding to atk in computeDamage)
      const beforeAtk = skillEffectSlots(skill)
        .filter((e) => e.timing === "before" && e.type === "buff" && (e.stat || "atk") === "atk")
        .reduce((sum, e) => sum + (e.value || 0), 0);
      const est = computeDamage(actor, other, (skill.value || 0) + beforeAtk);
      base = `≈ ${est} dmg to ${other.name}`;
      if (actor.crit_chance > 0) {
        base += ` · ${round1(actor.crit_chance)}% to crit for ≈ ${Math.round(est * (1 + actor.crit_dmg / 100))}`;
      }
      break;
    }
  }
  for (const eff of skillEffectSlots(skill)) {
    const secondary = effectSlotPreview(actor, other, eff);
    if (secondary) base += ` · ${secondary}`;
  }
  if (skill.hp_cost) {
    base += ` · sacrifices ${round1(skill.hp_cost)} HP at turn's end`;
    if (skill.hp_cost >= actor.hp) base += " — this WILL down you!";
  }
  // shown before use too, so the cooldown cost is known ahead of committing to the skill
  return skill.cooldown ? `${base} · ${skill.cooldown}-turn cooldown` : base;
}

/* Read-only mirror of applyEffectSlot's magnitude/target/duration logic, for the
   action-button preview shown before a skill is actually cast. */
function effectSlotPreview(actor, other, eff) {
  const effType = eff.type;
  if (!effType) return "";
  const duration = eff.duration || EFFECT_DURATION;
  const pre = eff.timing === "before" ? ", pre-hit" : "";

  if (effType === "buff") {
    const key = eff.stat || "atk";
    return key === "gauge"
      ? `also +${round1(eff.value)} attack bar (self, instant)`
      : `also +${round1(eff.value)} ${STAT_LABELS[key] || key} (self, ${duration}t${pre})`;
  }

  const selfDemerit = eff.target === "self";
  if (effType === "stun") {
    const victim = selfDemerit ? actor : other;
    if (!selfDemerit && victim.stunImmuneTurns > 0) return `Stun resisted — ${victim.name} just broke free`;
    const turns = Math.max(1, Math.round(eff.value) || 1);
    return `also stuns ${selfDemerit ? "self" : victim.name} for ${turns} turn${turns === 1 ? "" : "s"}${pre}`;
  }
  if (!selfDemerit && isResisted(actor, other)) return "secondary effect resisted (Effect Res too high)";
  const who = selfDemerit ? "self" : other.name;
  const victim = selfDemerit ? actor : other;
  const magnitude = selfDemerit ? (eff.value || 0) : computeLandedEffectMagnitude(actor, other, eff.value);
  if (effType === "slow") {
    const reduction = cappedSpeedReduction(victim, magnitude);
    const floorHint = reduction < magnitude ? `, floor ${round1(minimumBattleSpeed(victim))}` : "";
    return `also -${round1(reduction)} Speed to ${who} (${duration}t${pre}${floorHint})`;
  }
  if (effType === "bleed" || effType === "poison") return `also ≈ ${round1(magnitude)} dmg/turn ${effType} to ${who} (${duration}t${pre})`;
  const key = eff.stat || "atk";
  const shownReduction = key === "speed" ? cappedSpeedReduction(victim, magnitude) : magnitude;
  const floorHint = key === "speed" && shownReduction < magnitude
    ? `, floor ${round1(minimumBattleSpeed(victim))}` : "";
  return key === "gauge"
    ? `also -${round1(magnitude)} attack bar to ${who} (instant)`
    : `also -${round1(shownReduction)} ${STAT_LABELS[key] || key} to ${who} (${duration}t${pre}${floorHint})`;
}

const ACTION_KIND_LABELS = {
  "kind-damage": "Attack", "kind-heal": "Recovery", "kind-buff": "Buff",
  "kind-debuff": "Debuff", "kind-thorns": "Buff", "kind-stun": "Control",
  "kind-bleed": "Damage over time", "kind-poison": "Damage over time",
  "kind-slow": "Debuff", "kind-immunity": "Buff",
  defend: "Guard", "auto-decide": "Assist",
};

function makeActionBtn(kindClass, label, preview, disabled, onClick, meta = {}) {
  const b = document.createElement("button");
  b.type = "button";
  if (kindClass) b.className = kindClass;
  b.disabled = !!disabled;
  const top = document.createElement("span");
  top.className = "fa-top";
  const kind = document.createElement("span");
  kind.className = "fa-kind";
  kind.textContent = meta.kindLabel || ACTION_KIND_LABELS[kindClass] || "Action";
  top.appendChild(kind);
  const cost = document.createElement("span");
  cost.className = "fa-cost";
  cost.textContent = meta.cost || "No cost";
  top.appendChild(cost);
  b.appendChild(top);
  const lbl = document.createElement("span");
  lbl.className = "fa-label";
  lbl.textContent = label;
  b.appendChild(lbl);
  if (meta.description) {
    const desc = document.createElement("span");
    desc.className = "fa-description";
    desc.textContent = meta.description;
    b.appendChild(desc);
  }
  if (preview) {
    const sub = document.createElement("span");
    sub.className = "fa-preview";
    sub.textContent = preview;
    b.appendChild(sub);
  }
  b.onclick = onClick;
  return b;
}

function makeActionSection(title, className) {
  const section = document.createElement("section");
  section.className = `fight-action-section ${className || ""}`.trim();
  const heading = document.createElement("div");
  heading.className = "fight-action-section-title";
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "fight-action-grid";
  section.append(heading, grid);
  return { section, grid };
}

function renderActionPanel(actor) {
  const panel = $("fightActionPanel");
  const turnLbl = $("fightTurnIndicator");
  if (!actor) { panel.hidden = true; panel.innerHTML = ""; turnLbl.textContent = ""; return; }

  const other = actor === fight.a ? fight.b : fight.a;
  turnLbl.textContent = `${actor.name}'s turn`;
  panel.innerHTML = "";
  panel.hidden = false;

  const head = document.createElement("div");
  head.className = "fight-action-head";
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "Choose action";
  const actorName = document.createElement("strong");
  actorName.textContent = actor.name;
  const targetName = document.createElement("small");
  // Not every action targets the opponent (Buff, Heal, Immunity, Thorns and Defend
  // are self-only), so calling this fighter "Target" was misleading.
  targetName.textContent = `Opponent: ${other.name}`;
  head.append(eyebrow, actorName, targetName);
  panel.appendChild(head);

  const regularSkills = actor.skills.filter((skill) => !skill.is_inventory_item_action);
  const carriedActions = actor.skills.filter((skill) => skill.is_inventory_item_action);
  const tactics = makeActionSection("Tactics", "tactics");
  const skills = makeActionSection(`Skills (${regularSkills.length})`, "skills");
  const items = makeActionSection(`Battle items (${carriedActions.length})`, "items");
  panel.append(tactics.section, skills.section);
  if (carriedActions.length) panel.appendChild(items.section);

  const basicEst = computeDamage(actor, other, 0);
  let basicPreview = `≈ ${basicEst} dmg to ${other.name}`;
  if (actor.crit_chance > 0) {
    basicPreview += ` · ${round1(actor.crit_chance)}% to crit for ≈ ${Math.round(basicEst * (1 + actor.crit_dmg / 100))}`;
  }
  tactics.grid.appendChild(makeActionBtn(
    "kind-damage", "Basic Attack", basicPreview,
    false, () => chooseAndResolve(actor, { kind: "basic" }), { kindLabel: "Attack" },
  ));

  for (const skill of actor.skills) {
    const cost = skill.mana_cost || 0;
    const affordable = cost <= actor.mana;
    const cooldown = actor.cooldowns[skill.id] || 0;
    const hasUses = skillHasUses(skill);
    const atFullHp = skill.type === "heal" && actor.hp >= actor.maxHp;
    const usable = affordable && hasUses && !atFullHp && !cooldown;
    const costBits = [];
    if (cost) costBits.push(`${round1(cost)} MP`);
    if (skill.hp_cost) costBits.push(`${round1(skill.hp_cost)} HP`);
    const costText = skill.is_inventory_item_action
      ? `${skill.uses_remaining}/${skill.uses_max} uses left`
      : (costBits.length ? costBits.join(" + ") : "No cost");
    let preview;
    if (!hasUses) preview = "no uses left this fight";
    else if (cooldown) preview = `on cooldown (${cooldown} turn${cooldown === 1 ? "" : "s"} left)`;
    else if (atFullHp) preview = "already at full health";
    else if (!affordable) preview = `needs ${round1(cost)} mana (have ${round1(actor.mana)})`;
    else preview = skillPreview(actor, other, skill);
    const targetGrid = skill.is_inventory_item_action ? items.grid : skills.grid;
    targetGrid.appendChild(makeActionBtn(
      `kind-${skill.type}`, skill.name, preview, !usable,
      () => chooseAndResolve(actor, { kind: "skill", skill }),
      {
        kindLabel: skill.is_inventory_item_action ? "Item" : undefined,
        cost: !hasUses ? "Depleted" : (cooldown ? `Cooldown ${cooldown}t` : costText),
        description: skill.description,
      },
    ));
  }

  if (!regularSkills.length) {
    const empty = document.createElement("div");
    empty.className = "fight-action-empty";
    empty.textContent = "No character or equipped-gear skills available. Basic Attack, Defend, and any carried item actions are still ready.";
    skills.grid.appendChild(empty);
  }

  tactics.grid.appendChild(makeActionBtn(
    "defend", "Defend", "halves damage taken until your next turn",
    false, () => chooseAndResolve(actor, { kind: "defend" }), { kindLabel: "Guard" },
  ));

  tactics.grid.appendChild(makeActionBtn(
    "auto-decide", "Auto (AI decides)", "let the AI pick this turn",
    false, () => chooseAndResolve(actor, chooseAction(actor)), { kindLabel: "Assist", cost: "1 turn" },
  ));
}

function fillFighterBoxLegacy(boxId, f) {
  const box = $(boxId);
  const status = (f.defending ? " [Defending]" : "") +
    (f.stunTurns > 0 ? ` [Stunned: ${f.stunTurns}]` : (f.stunImmuneTurns > 0 ? " [Resisting]" : ""));
  box.querySelector(".fighter-name").textContent = f.name + status;
  const hpPct = f.maxHp > 0 ? Math.max(0, Math.min(100, (f.hp / f.maxHp) * 100)) : 0;
  const manaPct = f.maxMana > 0 ? Math.max(0, Math.min(100, (f.mana / f.maxMana) * 100)) : 0;
  box.querySelector(".bar.hp .bar-fill").style.width = hpPct + "%";
  box.querySelector(".bar.hp .bar-label").textContent = `HP ${round1(f.hp)} / ${round1(f.maxHp)}`;
  box.querySelector(".bar.mana .bar-fill").style.width = manaPct + "%";
  box.querySelector(".bar.mana .bar-label").textContent = `Mana ${round1(f.mana)} / ${round1(f.maxMana)}`;

  const pills = [];
  for (const eff of f.activeEffects) {
    if (eff.kind === "dot") {
      pills.push({ text: `${eff.label} -${round1(eff.amount)}/turn (${eff.turnsLeft}t)`, cls: "dot" });
    } else {
      const sign = eff.amount >= 0 ? "+" : "";
      pills.push({ text: `${eff.label} ${sign}${round1(eff.amount)} (${eff.turnsLeft}t)`, cls: eff.amount >= 0 ? "buff" : "debuff" });
    }
  }
  if (f.debuffImmuneTurns > 0) {
    pills.push({ text: `Debuff Immune (${f.debuffImmuneTurns}t)`, cls: "immune" });
  }
  for (const skill of f.skills) {
    const cd = f.cooldowns[skill.id];
    if (cd) pills.push({ text: `${skill.name} on cooldown (${cd}t)`, cls: "cooldown" });
  }
  const effectsBox = box.querySelector(".fighter-effects");
  effectsBox.innerHTML = "";
  for (const pill of pills) {
    const span = document.createElement("span");
    span.className = `effect-pill ${pill.cls}`;
    span.textContent = pill.text;
    effectsBox.appendChild(span);
  }
}

function renderFighterEffectGroup(box, kind, effects) {
  const effectsBox = box.querySelector(`.fighter-effects[data-effect-kind="${kind}"]`);
  const group = effectsBox.closest(".fighter-effect-group");
  group.querySelector(".fighter-effect-heading b").textContent = effects.length;
  group.hidden = kind === "cooldown" && effects.length === 0;
  effectsBox.innerHTML = "";
  if (!effects.length) {
    const empty = document.createElement("span");
    empty.className = "effect-empty";
    empty.textContent = "None active";
    effectsBox.appendChild(empty);
    return;
  }
  for (const effect of effects) {
    const pill = document.createElement("div");
    pill.className = `effect-pill ${effect.cls}`;
    const name = document.createElement("span");
    name.className = "effect-name";
    name.textContent = effect.name;
    const detail = document.createElement("span");
    detail.className = "effect-detail";
    detail.textContent = effect.detail;
    pill.append(name, detail);
    effectsBox.appendChild(pill);
  }
}

function fillFighterBox(boxId, f) {
  const box = $(boxId);
  box.querySelector(".fighter-name").textContent = f.name;

  const portrait = box.querySelector(".fighter-portrait img");
  const fallback = box.querySelector(".fighter-portrait-fallback");
  if (f.portraitUrl) {
    portrait.src = f.portraitUrl;
    applyThumbnailStyle(portrait, f.portraitCrop);
    portrait.alt = `${f.name} portrait`;
    portrait.hidden = false;
    fallback.hidden = true;
  } else {
    portrait.removeAttribute("src");
    portrait.alt = "";
    portrait.hidden = true;
    fallback.hidden = false;
    fallback.textContent = (f.name || "?").trim().charAt(0) || "?";
  }

  const stateBadge = box.querySelector(".fighter-state-badge");
  stateBadge.className = "fighter-state-badge";
  if (f.hp <= 0) { stateBadge.textContent = "Down"; stateBadge.classList.add("danger"); }
  else if (f.stunTurns > 0) { stateBadge.textContent = `Stunned ${f.stunTurns}t`; stateBadge.classList.add("danger"); }
  else if (!fight.over && fight.actor === f) { stateBadge.textContent = "Acting"; stateBadge.classList.add("acting"); }
  else if (f.defending) { stateBadge.textContent = "Guarding"; stateBadge.classList.add("guard"); }
  else stateBadge.textContent = "Ready";

  const hpPct = f.maxHp > 0 ? Math.max(0, Math.min(100, (f.hp / f.maxHp) * 100)) : 0;
  const manaPct = f.maxMana > 0 ? Math.max(0, Math.min(100, (f.mana / f.maxMana) * 100)) : 0;
  box.querySelector(".bar.hp .bar-fill").style.width = hpPct + "%";
  box.querySelector(".bar.hp .bar-label").textContent = `HP ${round1(f.hp)} / ${round1(f.maxHp)}`;
  box.querySelector(".bar.mana .bar-fill").style.width = manaPct + "%";
  box.querySelector(".bar.mana .bar-label").textContent = `Mana ${round1(f.mana)} / ${round1(f.maxMana)}`;

  const liveStats = {
    atk: f.atk, speed: f.speed, effectiveness: f.effectiveness,
    effect_resistance: f.effect_resistance, dmg_resist: f.dmg_resist,
    gauge: Math.max(0, f.gauge),
  };
  for (const statBox of box.querySelectorAll("[data-fight-stat]")) {
    const key = statBox.dataset.fightStat;
    const value = liveStats[key] || 0;
    const suffix = key === "dmg_resist" || key === "gauge" ? "%" : "";
    statBox.querySelector("strong").textContent = round1(value) + suffix;
    const deltaBox = statBox.querySelector("small");
    deltaBox.className = "";
    if (key === "gauge") {
      deltaBox.textContent = "turn meter";
      statBox.title = "Attack Bar: 100% grants a turn";
      continue;
    }
    const base = f.baseStats[key] || 0;
    const delta = value - base;
    statBox.title = `Battle start: ${round1(base)}${suffix}`;
    if (Math.abs(delta) < 0.05) deltaBox.textContent = "base";
    else {
      deltaBox.textContent = `${delta > 0 ? "+" : ""}${round1(delta)}${suffix}`;
      deltaBox.classList.add(delta > 0 ? "up" : "down");
    }
  }

  const positive = [];
  const negative = [];
  for (const eff of f.activeEffects) {
    if (eff.kind === "dot") {
      negative.push({ name: eff.label, detail: `${round1(eff.amount)} HP/turn · ${eff.turnsLeft}t`, cls: "dot" });
    } else {
      const sign = eff.amount >= 0 ? "+" : "";
      const stat = STAT_LABELS[eff.stat] || eff.stat || "Stat";
      const item = { name: eff.label, detail: `${sign}${round1(eff.amount)} ${stat} · ${eff.turnsLeft}t`, cls: eff.amount >= 0 ? "buff" : "debuff" };
      (eff.amount >= 0 ? positive : negative).push(item);
    }
  }
  if (f.debuffImmuneTurns > 0) positive.push({ name: "Debuff Immunity", detail: `${f.debuffImmuneTurns}t left`, cls: "immune" });
  if (f.defending) positive.push({ name: "Defending", detail: "-50% incoming damage", cls: "buff" });
  if (f.stunImmuneTurns > 0) positive.push({ name: "Stun resistance", detail: "until next action", cls: "immune" });
  if (f.thorns > 0) positive.push({ name: "Thorns", detail: `${round1(f.thorns)}% reflected`, cls: "buff" });
  if (f.stunTurns > 0) negative.push({ name: "Stunned", detail: `${f.stunTurns} turn${f.stunTurns === 1 ? "" : "s"} left`, cls: "debuff" });

  const cooldowns = [];
  for (const skill of f.skills) {
    const cd = f.cooldowns[skill.id];
    if (cd) cooldowns.push({ name: skill.name, detail: `${cd}t left`, cls: "cooldown" });
  }
  renderFighterEffectGroup(box, "positive", positive);
  renderFighterEffectGroup(box, "negative", negative);
  renderFighterEffectGroup(box, "cooldown", cooldowns);
}

function renderFightState() {
  if (!fight) return;
  fillFighterBox("fighterA", fight.a);
  fillFighterBox("fighterB", fight.b);
  $("fighterA").classList.toggle("acting", !fight.over && fight.actor === fight.a);
  $("fighterB").classList.toggle("acting", !fight.over && fight.actor === fight.b);
  $("fightAutoBtn").disabled = fight.over;
}

function stopAutoBattle() {
  if (fightAutoTimer) { clearTimeout(fightAutoTimer); fightAutoTimer = null; }
  $("fightAutoBtn").textContent = "Auto-Battle";
  if (fight) {
    fight.autoMode = false;
    if (!fight.over && fight.actor) renderActionPanel(fight.actor);
  }
}

function startAutoBattle() {
  if (!fight || fight.over) return;
  fight.autoMode = true;
  $("fightAutoBtn").textContent = "Stop";
  renderActionPanel(null);
  if (fight.actor) {
    fightAutoTimer = setTimeout(() => {
      if (!fight || fight.over || !fight.autoMode) return;
      chooseAndResolve(fight.actor, chooseAction(fight.actor));
    }, 350);
  }
}
