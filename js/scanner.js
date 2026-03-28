// ============================================================
// LONGHAUL — Multispectrum Scanner
// Radar-style contact display with short/medium/long range
// Active tracking reveals progressive info about contacts
// ============================================================

import { getEntitiesInRange, entityDistanceAU, bearingTo, relativeApproachSpeed } from './entities.js';
import { isTransponderOn } from './comms.js';

// ---- CONSTANTS ----

// Range levels in AU
export const SCANNER_RANGES = [
  { name: 'SHORT', au: 0.001, label: '~150k km', description: 'All sensors — thermal, EM, lidar' },
  { name: 'MED', au: 0.01, label: '~1.5M km', description: 'Multi-range radar' },
  { name: 'LONG', au: 0.1, label: '~15M km', description: 'Visual telescopes — drive plumes' },
];

// Active tracking info reveal thresholds (minutes of tracking)
const TRACK_REVEAL = {
  VELOCITY: 5,
  HEADING: 10,
  THRUST_STATE: 15,
  MASS: 30,
  FULL_PROFILE: 60,
};

// ---- INITIALIZATION ----

export function initScanner(gameState) {
  gameState.scanner = {
    range: 0,              // 0=short, 1=medium, 2=long
    selectedContact: null, // entity id
    trackedContact: null,  // entity id (active tracking / locked)
    scanTimers: {},        // per-entity scan accumulation in minutes
    contacts: [],          // detected contacts this tick
  };
}

// ---- PER-MINUTE TICK ----

export function scannerTick(gameState, days) {
  const scanner = gameState.scanner;
  if (!scanner) return;

  const entities = gameState.entities || [];
  const shipPos = gameState.shipPosition;
  const rangeAU = SCANNER_RANGES[scanner.range].au;

  // Detect entities within current range
  const inRange = getEntitiesInRange(entities, shipPos, rangeAU);

  // Build contact list with detection filtering
  scanner.contacts = [];

  for (const entity of inRange) {
    const dist = entityDistanceAU(shipPos, entity.position);
    const detected = isEntityDetectable(entity, dist, scanner.range);

    if (!detected) continue;

    const bearing = bearingTo(shipPos, entity.position);
    const signalType = scanner.range === 0 ? 'multi' : scanner.range === 1 ? 'radar' : 'visual';

    const contact = {
      entityId: entity.id,
      bearing,
      range: dist,
      signalType,
      // Basic info (always if transponder on)
      name: entity.transponderActive ? entity.name : null,
      type: entity.transponderActive ? entity.type : null,
      faction: entity.transponderActive ? entity.faction : null,
      shipClass: entity.transponderActive ? entity.shipClass : null,
      // Drive plume visible?
      plumeVisible: entity.thrustActive,
      driveSignature: entity.thrustActive ? entity.driveSignature : null,
      // SOS?
      sosActive: entity.sosActive,
      // Tracking reveals
      relativeVelocity: null,
      heading: null,
      thrustState: null,
      mass: null,
    };

    // Progressive info reveal based on per-contact scan time
    const scanTime = scanner.scanTimers[entity.id] || 0;
    if (scanTime > 0) {
      const shipVel = gameState.physics.velocity;
      if (scanTime >= TRACK_REVEAL.VELOCITY) {
        contact.relativeVelocity = relativeApproachSpeed(
          shipPos, shipVel, entity.position, entity.velocity
        );
      }
      if (scanTime >= TRACK_REVEAL.HEADING) {
        contact.heading = entity.heading;
      }
      if (scanTime >= TRACK_REVEAL.THRUST_STATE) {
        contact.thrustState = entity.thrustActive ? `${entity.thrustG.toFixed(1)}G` : 'COASTING';
      }
      if (scanTime >= TRACK_REVEAL.MASS) {
        contact.mass = entity.mass;
      }
      // Full profile also reveals name even without transponder
      if (scanTime >= TRACK_REVEAL.FULL_PROFILE) {
        contact.name = entity.name;
        contact.type = entity.type;
        contact.faction = entity.faction;
        contact.shipClass = entity.shipClass;
      }
    }

    scanner.contacts.push(contact);
  }

  // Increment per-contact scan timers: +1/min passive, +3/min if locked
  const visibleIds = new Set(scanner.contacts.map(c => c.entityId));
  for (const id of visibleIds) {
    const rate = (scanner.trackedContact === id) ? 3 : 1;
    scanner.scanTimers[id] = (scanner.scanTimers[id] || 0) + rate;
  }
  // Decay timers for contacts no longer visible
  for (const id of Object.keys(scanner.scanTimers)) {
    if (!visibleIds.has(id)) {
      scanner.scanTimers[id] = Math.max(0, scanner.scanTimers[id] - 2);
      if (scanner.scanTimers[id] <= 0) delete scanner.scanTimers[id];
    }
  }

  // Clear lock if target lost
  if (scanner.trackedContact && !visibleIds.has(scanner.trackedContact)) {
    scanner.trackedContact = null;
  }

  // Validate selected contact still exists
  if (scanner.selectedContact) {
    const stillVisible = scanner.contacts.some(c => c.entityId === scanner.selectedContact);
    if (!stillVisible) scanner.selectedContact = null;
  }
}

// ---- DETECTION LOGIC ----

function isEntityDetectable(entity, distAU, rangeLevel) {
  // Short range: all sensors — detect everything
  if (rangeLevel === 0) return true;

  // Medium range: radar — detect transponder on, stations (large mass), thrusting
  if (rangeLevel === 1) {
    if (entity.transponderActive) return true;
    if (entity.type === 'station') return true; // large radar cross-section
    if (entity.thrustActive) return true;
    if (entity.sosActive) return true;
    if (entity.mass > 50000) return true; // large hull detectable on radar
    return false;
  }

  // Long range: visual telescopes — only drive plumes and active transponders
  if (rangeLevel === 2) {
    if (entity.thrustActive) return true; // drive plume visible
    if (entity.transponderActive) return true; // active signal
    if (entity.sosActive) return true; // SOS broadcast
    return false;
  }

  return false;
}

// ---- PLAYER ACTIONS ----

export function selectContact(gameState, entityId) {
  const scanner = gameState.scanner;
  if (!scanner) return;
  scanner.selectedContact = entityId;
}

export function deselectContact(gameState) {
  const scanner = gameState.scanner;
  if (!scanner) return;
  scanner.selectedContact = null;
}

export function startTracking(gameState, entityId) {
  const scanner = gameState.scanner;
  if (!scanner) return { success: false, message: 'No scanner' };

  if (scanner.trackedContact === entityId) {
    // Unlock
    scanner.trackedContact = null;
    return { success: true, active: false, message: 'Lock disengaged — ranging laser off' };
  }

  scanner.trackedContact = entityId;
  scanner.selectedContact = entityId;

  return { success: true, active: true, message: 'Target locked — painting with ranging laser' };
}

export function stopTracking(gameState) {
  const scanner = gameState.scanner;
  if (!scanner) return;
  scanner.trackedContact = null;
}

export function setRange(gameState, level) {
  const scanner = gameState.scanner;
  if (!scanner) return;
  scanner.range = Math.max(0, Math.min(2, level));
}

export function getTrackedEntity(gameState) {
  if (!gameState.scanner || !gameState.scanner.trackedContact) return null;
  const entities = gameState.entities || [];
  return entities.find(e => e.id === gameState.scanner.trackedContact) || null;
}

export function getSelectedContact(gameState) {
  if (!gameState.scanner || !gameState.scanner.selectedContact) return null;
  return gameState.scanner.contacts.find(c => c.entityId === gameState.scanner.selectedContact) || null;
}

// ---- RENDERING ----

export function renderScanner(container, gameState) {
  if (!container || !gameState || !gameState.scanner) return;

  const scanner = gameState.scanner;
  const rangeData = SCANNER_RANGES[scanner.range];
  const rangeAU = rangeData.au;
  const contacts = scanner.contacts || [];

  // SVG dimensions — use container size
  const w = container.clientWidth || 400;
  const h = container.clientHeight || 400;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(cx, cy) - 20; // main circle radius

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);

  // Background
  parts.push(`<rect width="${w}" height="${h}" fill="#080C0F"/>`);

  // Range rings (3 concentric)
  for (let i = 1; i <= 3; i++) {
    const r = radius * (i / 3);
    const opacity = 0.15 + i * 0.05;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1A3A4A" stroke-width="0.5" opacity="${opacity}"/>`);
    // Range label
    const labelDist = rangeAU * (i / 3);
    const labelText = formatDistance(labelDist);
    parts.push(`<text x="${cx + r + 3}" y="${cy - 3}" fill="#3A6A7A" font-size="8" font-family="var(--font-mono)">${labelText}</text>`);
  }

  // Cross-hairs
  parts.push(`<line x1="${cx - radius}" y1="${cy}" x2="${cx + radius}" y2="${cy}" stroke="#1A3A4A" stroke-width="0.3"/>`);
  parts.push(`<line x1="${cx}" y1="${cy - radius}" x2="${cx}" y2="${cy + radius}" stroke="#1A3A4A" stroke-width="0.3"/>`);

  // Diagonal lines
  parts.push(`<line x1="${cx - radius * 0.707}" y1="${cy - radius * 0.707}" x2="${cx + radius * 0.707}" y2="${cy + radius * 0.707}" stroke="#1A3A4A" stroke-width="0.2"/>`);
  parts.push(`<line x1="${cx - radius * 0.707}" y1="${cy + radius * 0.707}" x2="${cx + radius * 0.707}" y2="${cy - radius * 0.707}" stroke="#1A3A4A" stroke-width="0.2"/>`);

  // Ship at center
  parts.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="#4FD1C5" opacity="0.9"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="#4FD1C5" stroke-width="0.5" opacity="0.5"/>`);

  // Contacts
  for (const contact of contacts) {
    const dist = contact.range;
    if (dist > rangeAU) continue;

    const frac = dist / rangeAU;
    const px = cx + Math.cos(contact.bearing) * frac * radius;
    const py = cy + Math.sin(contact.bearing) * frac * radius;

    // Color based on type/faction
    let color = '#8A8A6A'; // unknown
    if (contact.faction === 'MCRN') color = '#C1553B';
    else if (contact.faction === 'UNN') color = '#4A90D9';
    else if (contact.faction === 'OPA') color = '#E2A355';
    else if (contact.faction === 'Belter') color = '#7EC8D9';
    else if (contact.type === 'station') color = '#4FD1C5';

    // SOS override
    const isSOS = contact.sosActive;
    if (isSOS) color = '#E25555';

    const isSelected = scanner.selectedContact === contact.entityId;
    const isTracked = scanner.trackedContact === contact.entityId;

    // Contact point
    const pointSize = contact.type === 'station' ? 4 : 3;

    // SOS distress pulse ring
    if (isSOS) {
      parts.push(`<circle cx="${px}" cy="${py}" r="${pointSize}" fill="none" stroke="#E25555" stroke-width="0.8" opacity="0" style="pointer-events:none">`);
      parts.push(`<animate attributeName="r" values="${pointSize};${pointSize + 12};${pointSize + 18}" dur="2s" repeatCount="indefinite"/>`);
      parts.push(`<animate attributeName="opacity" values="0.6;0.2;0" dur="2s" repeatCount="indefinite"/>`);
      parts.push(`</circle>`);
    }

    // Visible dot + decorations (all pointer-events:none)
    parts.push(`<circle cx="${px}" cy="${py}" r="${pointSize}" fill="${color}" opacity="0.9" style="pointer-events:none"/>`);

    // Drive plume indicator
    if (contact.plumeVisible) {
      parts.push(`<circle cx="${px}" cy="${py}" r="${pointSize + 3}" fill="none" stroke="${color}" stroke-width="0.5" opacity="0.4" style="pointer-events:none"/>`);
    }

    // Selection ring
    if (isSelected) {
      parts.push(`<circle cx="${px}" cy="${py}" r="${pointSize + 5}" fill="none" stroke="${color}" stroke-width="1" opacity="0.8" style="pointer-events:none">`);
      parts.push(`<animate attributeName="r" values="${pointSize + 4};${pointSize + 7};${pointSize + 4}" dur="2s" repeatCount="indefinite"/>`);
      parts.push(`</circle>`);
    }

    // Tracking indicator
    if (isTracked) {
      parts.push(`<circle cx="${px}" cy="${py}" r="${pointSize + 8}" fill="none" stroke="#E2A355" stroke-width="0.5" stroke-dasharray="3,2" opacity="0.7" style="pointer-events:none">`);
      parts.push(`<animateTransform attributeName="transform" type="rotate" from="0 ${px} ${py}" to="360 ${px} ${py}" dur="4s" repeatCount="indefinite"/>`);
      parts.push(`</circle>`);
    }

    // Name label (if known)
    const label = contact.name || (contact.driveSignature ? contact.driveSignature : 'UNKNOWN');
    if (label && frac < 0.85) {
      parts.push(`<text x="${px + pointSize + 4}" y="${py + 3}" fill="${color}" font-size="7" font-family="var(--font-mono)" opacity="0.8" style="pointer-events:none">${escapeXml(label)}</text>`);
      // SOS tag next to name
      if (isSOS) {
        const labelWidth = label.length * 4.5 + 8;
        parts.push(`<text x="${px + pointSize + 4 + labelWidth}" y="${py + 3}" fill="#E25555" font-size="6" font-family="var(--font-pixel)" opacity="0.9" style="pointer-events:none">SOS</text>`);
      }
    }

    // Invisible hit area — rendered LAST so it's on top of all decorations
    parts.push(`<circle cx="${px}" cy="${py}" r="20" fill="transparent" data-contact="${contact.entityId}" style="cursor:pointer;pointer-events:all"/>`);
  }

  // Range label (top-left)
  parts.push(`<text x="8" y="14" fill="#4FD1C5" font-size="9" font-family="var(--font-mono)">${rangeData.name} RANGE — ${rangeData.label}</text>`);
  parts.push(`<text x="8" y="24" fill="#3A6A7A" font-size="7" font-family="var(--font-mono)">${rangeData.description}</text>`);

  // Contact count (top-right)
  parts.push(`<text x="${w - 8}" y="14" fill="#3A6A7A" font-size="8" font-family="var(--font-mono)" text-anchor="end">${contacts.length} CONTACT${contacts.length !== 1 ? 'S' : ''}</text>`);

  // Tracking status
  if (scanner.trackedContact) {
    const tracked = contacts.find(c => c.entityId === scanner.trackedContact);
    const trackLabel = tracked?.name || tracked?.driveSignature || 'UNKNOWN';
    const lockTime = scanner.scanTimers?.[scanner.trackedContact] || 0;
    parts.push(`<text x="${w - 8}" y="26" fill="#E2A355" font-size="8" font-family="var(--font-mono)" text-anchor="end">TRACKING: ${escapeXml(trackLabel)} [${lockTime}m]</text>`);
  }

  parts.push(`</svg>`);
  container.innerHTML = parts.join('');
}

// ---- HELPERS ----

function formatDistance(au) {
  const km = au * 149_597_870.7;
  if (km < 1000) return `${Math.round(km)} km`;
  if (km < 1_000_000) return `${(km / 1000).toFixed(0)}k km`;
  return `${(km / 1_000_000).toFixed(1)}M km`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
