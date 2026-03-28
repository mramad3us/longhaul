// ============================================================
// LONGHAUL — Communications System
// Radio contacts, transponder control, SOS broadcasts
// ============================================================

import { getEntitiesInRange, entityDistanceAU } from './entities.js';

// ---- CONSTANTS ----

// Radio range in AU (~15 million km — realistic for deep-space high-gain antenna)
const RADIO_RANGE_AU = 0.1;

// SOS is broadcast at maximum power, detectable further out
const SOS_RANGE_AU = 0.3;

// ---- INITIALIZATION ----

export function initComms(gameState) {
  gameState.comms = {
    transponderOn: true,
    sosActive: false,
    autoSosOnBlackout: true,
    radioContacts: [],  // entity IDs within radio range
    messages: [],       // { time, from, text, type }
  };
}

// ---- PER-MINUTE TICK ----

export function commsTick(gameState, days) {
  const comms = gameState.comms;
  if (!comms) return;

  const entities = gameState.entities || [];
  const shipPos = gameState.shipPosition;

  // Update radio contacts (entities within radio range)
  const inRange = getEntitiesInRange(entities, shipPos, RADIO_RANGE_AU);
  comms.radioContacts = inRange.map(e => ({
    entityId: e.id,
    name: e.name,
    type: e.type,
    faction: e.faction,
    distance: entityDistanceAU(shipPos, e.position),
    transponderOn: e.transponderActive,
    sosActive: e.sosActive,
  }));

  // Auto-SOS during blackout
  const blackout = gameState.resources.power.current <= 0 &&
    gameState.reactor && gameState.reactor.status === 'offline';

  if (blackout && comms.autoSosOnBlackout && !comms.sosActive) {
    comms.sosActive = true;
  }

  // Clear auto-SOS when power returns
  if (!blackout && comms.sosActive && comms.autoSosOnBlackout) {
    // Only auto-clear if it was auto-triggered, not manual
    // We use a flag to track this
    if (comms._autoSos) {
      comms.sosActive = false;
      comms._autoSos = false;
    }
  }

  if (blackout && comms.sosActive) {
    comms._autoSos = true;
  }

  // Check if any entity in SOS range is broadcasting SOS
  const sosRange = getEntitiesInRange(entities, shipPos, SOS_RANGE_AU);
  for (const entity of sosRange) {
    if (entity.sosActive) {
      const alreadyLogged = comms.messages.some(m =>
        m.type === 'sos-received' && m.fromId === entity.id &&
        m.gameMinute >= (gameState.time.hour * 60 + gameState.time.minute) - 60
      );
      if (!alreadyLogged) {
        comms.messages.push({
          time: `${String(gameState.time.hour).padStart(2, '0')}:${String(gameState.time.minute).padStart(2, '0')}`,
          from: entity.name,
          fromId: entity.id,
          text: `MAYDAY — ${entity.name} broadcasting distress signal`,
          type: 'sos-received',
          gameMinute: gameState.time.hour * 60 + gameState.time.minute,
        });
      }
    }
  }

  // Cap message history
  if (comms.messages.length > 100) {
    comms.messages = comms.messages.slice(-50);
  }
}

// ---- PLAYER ACTIONS ----

export function toggleTransponder(gameState) {
  const comms = gameState.comms;
  if (!comms) return { success: false, message: 'No comms system' };

  comms.transponderOn = !comms.transponderOn;
  return {
    success: true,
    active: comms.transponderOn,
    message: comms.transponderOn
      ? 'Transponder active — broadcasting ship identity'
      : 'Transponder disabled — ship identity masked',
  };
}

export function triggerSOS(gameState) {
  const comms = gameState.comms;
  if (!comms) return { success: false, message: 'No comms system' };

  if (comms.sosActive) {
    comms.sosActive = false;
    comms._autoSos = false;
    return { success: true, active: false, message: 'SOS cancelled' };
  }

  comms.sosActive = true;
  return { success: true, active: true, message: 'SOS BROADCASTING — distress signal active' };
}

export function getRadioContacts(gameState) {
  if (!gameState.comms) return [];
  return gameState.comms.radioContacts;
}

export function isTransponderOn(gameState) {
  return gameState.comms ? gameState.comms.transponderOn : true;
}

export function isSosActive(gameState) {
  return gameState.comms ? gameState.comms.sosActive : false;
}

// Check if player ship is detectable by a given observer entity
export function isPlayerDetectable(gameState, observerPos, detectionRange) {
  const shipPos = gameState.shipPosition;
  const dist = entityDistanceAU(shipPos, observerPos);
  if (dist > detectionRange) return false;

  const comms = gameState.comms;

  // Transponder on = always detectable within range
  if (comms && comms.transponderOn) return true;

  // Thrusting = drive plume visible
  if (gameState.physics.thrustActive) return true;

  // SOS = broadcasting
  if (comms && comms.sosActive) return true;

  // Short range = always detectable (hull/heat signature)
  if (dist < 0.001) return true; // ~150,000 km

  return false;
}

// ---- HAIL DIALOGUE ----

const HAIL_DIALOGUE = {
  // Station hails by faction
  'station:OPA': [
    'Static crackles, then a voice — low, Belter-accented, unhurried. The station operator asks your business. In the background, you hear the hum of spin gravity and distant welding.',
    'A long pause after your hail. Then a clipped voice, suspicious: "State your registry and purpose, inyalowda." The OPA dock controller waits.',
    'The channel opens with a burst of Belter patois, then switches to accented English. "Hoy, kopeng. What brings you to our rock?"',
  ],
  'station:UNN': [
    'The response is immediate and professional. A UN naval communications officer confirms your hail, reads back your transponder ident, and requests your approach vector and docking authorization.',
    'After a brief authentication handshake, a crisp voice comes through: "Copy your hail. State your business and stand by for traffic routing."',
  ],
  'station:MCRN': [
    'A Martian naval operator responds with clipped efficiency. They verify your transponder against their database before asking your purpose. Everything by the book.',
    'The channel clicks open. "MCRN traffic control. We have your ident. Transmit docking credentials or state the nature of your approach."',
  ],
  'station:Belter': [
    'Someone picks up after a while — sounds like they were in the middle of something. Clanking tools in the background. "Yeah, what do you need? We got ice, we got parts. Maybe."',
    'A tired voice answers. The station sounds busy — multiple conversations bleeding through on the same channel. "Go ahead, we hear you."',
  ],
  'station:independent': [
    'The station operator responds after a delay, voice neutral and businesslike. "Receiving your hail. How can we assist?"',
    'A slightly bored voice answers from the station. "Go ahead with your traffic."',
  ],

  // Ship hails by faction
  'ship:MCRN': [
    'The Martian warship responds with cold precision. An officer identifies the vessel and asks — in a tone that is more command than question — why you are hailing a Mars Congressional Republic Navy vessel.',
    'Tight-beam response, encrypted. A weapons officer speaks: "We read your transponder. Keep your distance and state your intent." You can almost hear targeting computers spinning up.',
    'After a moment, a Martian voice — young, professional: "This is a MCRN vessel on patrol. Identify your cargo and heading."',
  ],
  'ship:UNN': [
    'A United Nations Navy communications officer answers your hail with practiced formality. They confirm your position and registry, then ask your purpose in a way that suggests they already know.',
    'The response comes through clean and professional. "UN Naval vessel acknowledging your hail. What is the nature of your communication?"',
  ],
  'ship:OPA': [
    'The channel opens with background noise — someone arguing, then cut off. A voice comes through, wary but not hostile. "Yeah, we hear you. What do you want, ke?"',
    'A Belter voice, rough around the edges: "Hoy. You hailing us? Better be worth the juice on this antenna."',
  ],
  'ship:Belter': [
    'After a long silence, someone answers. The voice is tired — the bone-deep weariness of a Belter who has spent too many hours in the black. "Go ahead. We\'re listening."',
    'A cautious voice comes through, tinged with static. "We read you. Not much to trade, but we can talk."',
    'The ice hauler\'s comms crackle to life. Someone clears their throat. "Didn\'t expect company out here. What\'s on your mind?"',
  ],
  'ship:independent': [
    'A neutral voice responds to your hail. "Receiving you. Go ahead with your traffic."',
    'After a moment, someone answers — sounds distracted, like they were running diagnostics. "Yeah, we\'re here. What do you need?"',
  ],
};

// Select a hail dialogue for an entity
export function getHailDialogue(entity) {
  if (!entity) return 'No response on this channel.';

  const key = `${entity.type}:${entity.faction}`;
  const lines = HAIL_DIALOGUE[key] || HAIL_DIALOGUE[`${entity.type}:independent`] || [];

  if (lines.length === 0) return 'The channel opens, but no one responds. Static fills the silence.';

  // Deterministic-ish pick based on entity id hash
  let hash = 0;
  for (let i = 0; i < entity.id.length; i++) hash = ((hash << 5) - hash + entity.id.charCodeAt(i)) | 0;
  return lines[Math.abs(hash) % lines.length];
}

export const RADIO_RANGE_AU_EXPORT = RADIO_RANGE_AU;
