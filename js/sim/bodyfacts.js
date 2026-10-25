// ============================================================
// LONGHAUL — What is known of each body: the reference sheet
//
// The ephemeris (ephemeris.js) holds what the simulation flies: radius,
// GM, the turn, the air's column, a circular orbit in the plane. This is
// the rest of what a ship's library knows, for the context sheet and the
// library: mass and density, the tilt of the axis, the real orbit's shape
// (the charts hold every orbit to a circle in the plane: the figures the
// game flies are the ephemeris'), temperatures, what the air is made of,
// the magnetic field, moons and rings, and a few lines on what the place
// is. For the Sun, its class and its numbers as a star.
//
// Values are the planetary fact sheets' (NASA/JPL), rounded. Plain data:
// nothing here moves anything.
// ============================================================

/** Kelvin from Celsius, for the tables written in °C. */
const K = (c) => Math.round(c + 273.15);

export const STAR_FACTS = {
  Sol: {
    class: 'G2V', classWords: 'a yellow dwarf on the main sequence, fusing hydrogen in its core',
    massKg: 1.989e30, lumW: 3.828e26, teffK: 5772, coreK: 1.57e7, ageGyr: 4.6, densityKgM3: 1408,
    composition: 'H 73.5% · He 24.9% · heavier 1.6% (by mass)', equatorialTurnD: 25.4, polarTurnD: 33.5, magnetic: 'an 11-year cycle of spots and flares; its wind fills the system to the heliopause',
    desc: 'An ordinary star, and the only one the system has: 99.86% of its mass. Everything here runs on its light, and every ship\'s radiators are sized against it.',
  },
};

export const BODY_FACTS = {
  Mercury: { massKg: 3.301e23, densityKgM3: 5429, tiltDeg: 0.03, ecc: 0.206, inclDeg: 7.0, tempK: { mean: K(167), min: K(-173), max: K(427) },
    air: 'none: a trace exosphere of O, Na, H, He, K', magnetic: 'weak global field (1% of Earth\'s)', moons: 0, albedo: 0.14,
    desc: 'A heavy iron world, three-quarters core, baked on its day side and frozen on its night side. Its solar collectors feed the UN grid; nobody lives on the surface by choice.' },
  Venus: { massKg: 4.867e24, densityKgM3: 5243, tiltDeg: 177.4, ecc: 0.007, inclDeg: 3.4, tempK: { mean: K(464), min: K(462), max: K(468) },
    air: 'CO₂ 96.5% · N₂ 3.5%; clouds of sulfuric acid at 50–70 km', magnetic: 'none (an induced field in the solar wind)', moons: 0, albedo: 0.69,
    desc: 'Earth\'s twin in size and nothing else: a crushing greenhouse, 92 bar of carbon dioxide over a surface hot enough to melt lead. It turns backward, slower than it goes round the Sun. Nobody lives there; at the cloud tops, 50–55 km up, the air is an Earth\'s pressure and temperature, and one day a floating station could ride there.' },
  Earth: { massKg: 5.972e24, densityKgM3: 5514, tiltDeg: 23.4, ecc: 0.017, inclDeg: 0.0, tempK: { mean: K(15), min: K(-89), max: K(57) },
    air: 'N₂ 78.1% · O₂ 20.9% · Ar 0.9% · CO₂ 0.04%', magnetic: 'strong global field; radiation belts', moons: 1, albedo: 0.37,
    desc: 'Thirty billion people, oceans over 71% of it, and the UN\'s capital. The only world in the system where a human can stand outside unprotected.' },
  Luna: { massKg: 7.346e22, densityKgM3: 3344, tiltDeg: 6.7, ecc: 0.055, inclDeg: 5.1, tempK: { mean: K(-20), min: K(-173), max: K(127) },
    air: 'none: a trace exosphere', magnetic: 'none (crustal remnants)', moons: 0, albedo: 0.12,
    desc: 'Earth\'s moon: old basalt seas and cratered highlands, its near side always toward Earth. Its yards build the UN Navy; its mass drivers throw cargo off it without a drop of reaction mass.' },
  Mars: { massKg: 6.417e23, densityKgM3: 3934, tiltDeg: 25.2, ecc: 0.094, inclDeg: 1.8, tempK: { mean: K(-25), min: K(-100), max: K(28) },
    air: 'N₂ 58% · O₂ 32% · CO₂ 8% · Ar 2%: breathable on the low ground (oxygen at 16.6 kPa, as on an Earth mountain at 2,500 m), thin and cold; dust storms still', magnetic: 'no global field (crustal remnants in the south): the domes keep out the radiation the thin air lets through', moons: 2, albedo: 0.2,
    desc: 'Two centuries into its terraforming. Mars has a sky now: half an Earth\'s air, nitrogen and oxygen, that a walker can breathe in the lowlands and the Mariner Valley if not in a hurry. A shallow young sea fills the northern plains, Hellas holds a lake, the polar caps have shrunk, and lichen and hardy grass grow where the water has come. The cities are still domed against the cold, the radiation and the storms, and the work will take centuries more. Olympus Mons still stands 22 km over the datum.' },
  Phobos: { massKg: 1.066e16, densityKgM3: 1876, tiltDeg: 0, ecc: 0.015, inclDeg: 1.1, tempK: { mean: 233, min: 160, max: 300 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.07, shape: '27 × 22 × 18 km',
    desc: 'A dark rubble moon spiralling slowly in toward Mars, its orbit faster than Mars turns: it rises in the west. The MCRN\'s yard is dug into it.' },
  Deimos: { massKg: 1.476e15, densityKgM3: 1471, tiltDeg: 0, ecc: 0.0003, inclDeg: 0.9, tempK: { mean: 233, min: 160, max: 300 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.07, shape: '15 × 12 × 11 km',
    desc: 'Mars\' smaller, farther moon: smooth regolith over a captured rock, hardly more than a mountain in orbit.' },
  Jupiter: { massKg: 1.898e27, densityKgM3: 1326, tiltDeg: 3.1, ecc: 0.049, inclDeg: 1.3, tempK: { mean: K(-110), min: K(-145), max: K(-108) }, tempAt: 'at the 1-bar level',
    air: 'H₂ 90% · He 10%; methane, ammonia, water clouds in bands', magnetic: 'the strongest of the planets: radiation belts that kill an unshielded crew in hours near Io', moons: 95, rings: 'faint dust rings', albedo: 0.54,
    desc: 'Twice the mass of every other planet together. No surface: the air thickens into metallic hydrogen far down. The Great Red Spot is a storm wider than Earth that has blown for centuries.' },
  Io: { massKg: 8.932e22, densityKgM3: 3528, tiltDeg: 0, ecc: 0.004, inclDeg: 0.05, tempK: { mean: 110, min: 90, max: 130 },
    air: 'SO₂ trace (about a nanobar), frozen out at night', magnetic: 'none of its own', moons: 0, albedo: 0.63,
    desc: 'The most volcanic place known: Jupiter\'s tides knead it hot, and four hundred volcanoes paint it sulfur yellow and red. Deep in Jupiter\'s radiation belts: a few corporate labs, nobody\'s home.' },
  Europa: { massKg: 4.800e22, densityKgM3: 3013, tiltDeg: 0.1, ecc: 0.009, inclDeg: 0.47, tempK: { mean: 102, min: 50, max: 125 },
    air: 'O₂ trace (a tenth of a micropascal)', magnetic: 'induced: a salt ocean under the ice', moons: 0, albedo: 0.67,
    desc: 'A shell of cracked ice over an ocean with twice Earth\'s water. Its ice is mined for reaction mass and drinking water across the Jovian moons.' },
  Ganymede: { massKg: 1.482e23, densityKgM3: 1936, tiltDeg: 0.2, ecc: 0.0013, inclDeg: 0.2, tempK: { mean: 110, min: 70, max: 152 },
    air: 'O₂ trace', magnetic: 'the only moon with a field of its own', moons: 0, albedo: 0.43,
    desc: 'The largest moon in the system, bigger than Mercury. Its domes and mirrors grow the outer planets\' food: the breadbasket of the Jovian system.' },
  Callisto: { massKg: 1.076e23, densityKgM3: 1834, tiltDeg: 0, ecc: 0.0074, inclDeg: 0.2, tempK: { mean: 134, min: 80, max: 165 },
    air: 'CO₂ trace', magnetic: 'induced (a deep ocean, perhaps)', moons: 0, albedo: 0.22,
    desc: 'The most cratered surface known, old and dark, outside the worst of Jupiter\'s radiation: the safe moon to build on.' },
  Saturn: { massKg: 5.683e26, densityKgM3: 687, tiltDeg: 26.7, ecc: 0.052, inclDeg: 2.5, tempK: { mean: K(-140), min: K(-178), max: K(-130) }, tempAt: 'at the 1-bar level',
    air: 'H₂ 96% · He 3%; ammonia clouds', magnetic: 'strong, aligned with its axis', moons: 146, rings: 'the great rings: ice, 280,000 km across and tens of metres thick', albedo: 0.50,
    desc: 'Less dense than water, and ringed with ice. Its moons are worked for water and volatiles; Titan is the prize.' },
  Mimas: { massKg: 3.75e19, densityKgM3: 1150, tiltDeg: 0, ecc: 0.020, inclDeg: 1.6, tempK: { mean: 64, min: 64, max: 92 }, air: 'none', magnetic: 'none', moons: 0, albedo: 0.96,
    desc: 'An ice ball with one great crater, Herschel, a third of its width across.' },
  Enceladus: { massKg: 1.08e20, densityKgM3: 1610, tiltDeg: 0, ecc: 0.0047, inclDeg: 0.01, tempK: { mean: 75, min: 32, max: 145 }, air: 'water vapour from its geysers', magnetic: 'none', moons: 0, albedo: 1.38,
    desc: 'The whitest thing in the system: geysers at its south pole throw an ocean\'s water into space and feed Saturn\'s E ring.' },
  Tethys: { massKg: 6.17e20, densityKgM3: 984, tiltDeg: 0, ecc: 0.0001, inclDeg: 1.1, tempK: { mean: 86, min: 64, max: 92 }, air: 'none', magnetic: 'none', moons: 0, albedo: 1.23,
    desc: 'Almost pure water ice, split by a canyon three-quarters of the way round it.' },
  Dione: { massKg: 1.095e21, densityKgM3: 1478, tiltDeg: 0, ecc: 0.0022, inclDeg: 0.02, tempK: { mean: 87, min: 64, max: 92 }, air: 'O₂ trace', magnetic: 'none', moons: 0, albedo: 0.99,
    desc: 'Ice over rock, its trailing side streaked with bright cliffs.' },
  Rhea: { massKg: 2.307e21, densityKgM3: 1236, tiltDeg: 0, ecc: 0.001, inclDeg: 0.35, tempK: { mean: 76, min: 53, max: 99 }, air: 'O₂ and CO₂ traces', magnetic: 'none', moons: 0, albedo: 0.95,
    desc: 'Saturn\'s second moon: cold, cratered ice, a cargo depot on the way in to Titan.' },
  Titan: { massKg: 1.345e23, densityKgM3: 1880, tiltDeg: 0.3, ecc: 0.029, inclDeg: 0.35, tempK: { mean: 94, min: 90, max: 95 },
    air: 'N₂ 98.4% · CH₄ 1.4% · H₂ 0.1%; an orange haze of hydrocarbons', magnetic: 'none', moons: 0, albedo: 0.22,
    desc: 'The only moon with real air: thicker than Earth\'s, cold enough that methane rains into lakes and seas. Fly a pressure suit there, not a vacuum suit, and you can fly with wings and your own arms.' },
  Iapetus: { massKg: 1.806e21, densityKgM3: 1088, tiltDeg: 0, ecc: 0.028, inclDeg: 15.5, tempK: { mean: 110, min: 90, max: 130 }, air: 'none', magnetic: 'none', moons: 0, albedo: 0.6,
    desc: 'Two-faced: one hemisphere coal-dark, the other bright as snow, and a ridge 20 km high round its equator.' },
  Uranus: { massKg: 8.681e25, densityKgM3: 1270, tiltDeg: 97.8, ecc: 0.047, inclDeg: 0.8, tempK: { mean: K(-195), min: K(-224), max: K(-195) }, tempAt: 'at the 1-bar level',
    air: 'H₂ 83% · He 15% · CH₄ 2.3%', magnetic: 'tilted 59° from its axis and off its centre', moons: 28, rings: 'thirteen narrow dark rings', albedo: 0.49,
    desc: 'An ice giant rolled on its side: each pole has forty-two years of day, then forty-two of night.' },
  Neptune: { massKg: 1.024e26, densityKgM3: 1638, tiltDeg: 28.3, ecc: 0.010, inclDeg: 1.8, tempK: { mean: K(-200), min: K(-218), max: K(-200) }, tempAt: 'at the 1-bar level',
    air: 'H₂ 80% · He 19% · CH₄ 1.5%', magnetic: 'tilted 47° and off its centre', moons: 16, rings: 'five faint rings', albedo: 0.44,
    desc: 'The windiest place known, 2,000 km/h at the cloud tops, blue with methane. The edge of where ships go to work.' },
  Ceres: { massKg: 9.38e20, densityKgM3: 2162, tiltDeg: 4, ecc: 0.076, inclDeg: 10.6, tempK: { mean: 168, min: 110, max: 235 },
    air: 'none: water vapour from its brines, now and then', magnetic: 'none', moons: 0, albedo: 0.09,
    desc: 'The largest body in the Belt, a dwarf planet of rock and ice with salt brines under its crust. Its station is the Belt\'s capital, spun up and crowded.' },
  Vesta: { massKg: 2.59e20, densityKgM3: 3456, tiltDeg: 29, ecc: 0.089, inclDeg: 7.1, tempK: { mean: 180, min: 85, max: 270 },
    air: 'none', magnetic: 'none (an old one frozen into its crust)', moons: 0, albedo: 0.42,
    desc: 'A dry, differentiated protoplanet with an iron core, and the brightest asteroid: the Rheasilvia basin at its south pole is 500 km across.' },
  Pallas: { massKg: 2.04e20, densityKgM3: 2890, tiltDeg: 84, ecc: 0.231, inclDeg: 34.8, tempK: { mean: 164, min: 120, max: 210 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.16,
    desc: 'A big, steeply tilted rock on an orbit inclined 35° to the rest: its refineries work the metal of the Belt.' },
  Hygiea: { massKg: 8.7e19, densityKgM3: 2060, tiltDeg: 60, ecc: 0.112, inclDeg: 3.8, tempK: { mean: 164, min: 120, max: 200 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.07,
    desc: 'Almost round, almost black: a carbonaceous dwarf in the outer Belt, a ring station round it.' },
  Juno: { massKg: 2.67e19, densityKgM3: 3200, tiltDeg: 51, ecc: 0.256, inclDeg: 13.0, tempK: { mean: 163, min: 110, max: 220 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.24,
    desc: 'A stony asteroid on an eccentric orbit; Tycho\'s yards, the OPA\'s, are built round it.' },
  Interamnia: { massKg: 3.5e19, densityKgM3: 2000, tiltDeg: 0, ecc: 0.155, inclDeg: 17.3, tempK: { mean: 160, min: 110, max: 200 },
    air: 'none', magnetic: 'none', moons: 0, albedo: 0.07,
    desc: 'A dark, round rock in the outer Belt, lawless space round it.' },
};

/** The reference facts for a body by name (or null). */
export const factsOf = (name) => BODY_FACTS[name] || null;
