// Static metadata of playable countries / territories shown on the source map.

// `acc` - accusative case and `male` - grammatical gender, used by the conquest announcement
// ("Азербайджан полностью захватил Полгонустан").
// The internal id 'armenia' is kept (province ids / neighbours in data/map.json depend on it);
// the country is shown to players as «Полгонустан».
// Order = order of the territories on the source map from north to south (data/map.json → countries).
export const COUNTRIES = [
  { id: 'russia', name: 'Россия', acc: 'Россию', male: false, color: '#0d45b4', troops: 9000 },
  { id: 'chechnya', name: 'Чечня', acc: 'Чечню', male: false, color: '#118227', troops: 6000 },
  { id: 'dagestan', name: 'Дагестан', acc: 'Дагестан', male: true, color: '#179b37', troops: 10000 },
  { id: 'georgia', name: 'Грузия', acc: 'Грузию', male: false, color: '#e53935', troops: 8000 },
  { id: 'abkhazia', name: 'Абхазия', acc: 'Абхазию', male: false, color: '#43a047', troops: 2500 },
  { id: 'south_ossetia', name: 'Южная Осетия', acc: 'Южную Осетию', male: false, color: '#f9c80e', troops: 2000 },
  { id: 'armenia', name: 'Полгонустан', acc: 'Полгонустан', male: true, color: '#fb8c00', troops: 7000 },
  { id: 'azerbaijan', name: 'Азербайджан', acc: 'Азербайджан', male: true, color: '#1e88e5', troops: 11000 },
  { id: 'artsakh', name: 'Нагорный Карабах', acc: 'Нагорный Карабах', male: true, color: '#8e24aa', troops: 3500 },
  { id: 'nakhchivan', name: 'Нахичевань', acc: 'Нахичевань', male: false, color: '#00897b', troops: 2500 },
];

export const COUNTRY_BY_ID = Object.fromEntries(COUNTRIES.map((c) => [c.id, c]));
