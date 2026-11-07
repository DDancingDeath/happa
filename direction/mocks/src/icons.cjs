// Proposed happa icon set: 24-grid, 1.75 stroke, round caps. Drawn for this proposal (no third-party paths except the WhatsApp mark already shipped in billing.html).
const P = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/><path d="M12 8v4l3 2"/>',
  wallet: '<path d="M5 7V6a2 2 0 0 1 2-2h10v3"/><rect x="3.5" y="7" width="17" height="13" rx="2.5"/><path d="M15.5 13.5h2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  contact: '<rect x="5.5" y="3" width="14" height="18" rx="2.5"/><circle cx="12.5" cy="10" r="2.5"/><path d="M9 17a3.5 3.5 0 0 1 7 0M3.5 8h2M3.5 12h2M3.5 16h2"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  chevR: '<path d="M9.5 6l6 6-6 6"/>',
  chevD: '<path d="M6 9.5l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
  triangle: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4M12 17v.01"/>',
  printer: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  tag: '<path d="M3.5 12V4.5H11l9.5 9.5-7 7z"/><circle cx="7.75" cy="8.75" r="1.5"/>',
  box: '<path d="M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5L12 11.5l8.5-4M12 11.5v9"/>',
  truck: '<path d="M2.5 6.5h11.5v9.5H2.5z"/><path d="M14 9.5h4l3 3v3.5h-7"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  trend: '<path d="M3.5 17l5.5-5.5 4 4 7.5-7.5"/><path d="M15 8h5.5v5.5"/>',
  banknote: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><circle cx="12" cy="12" r="2.75"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  sliders: '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  shield: '<path d="M12 3.5l7.5 3v5.5c0 4.5-3.2 7.6-7.5 8.6-4.3-1-7.5-4.1-7.5-8.6V6.5z"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>',
  flag: '<path d="M5.5 20.5V4M5.5 4.5h11l-2 4 2 4h-11"/>',
  home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5v10.5h13V9.5M10 20v-5.5h4V20"/>',
  wheat: '<path d="M12 21V7.5"/><path d="M12 12c-2.6 0-4-1.7-4-3.8 2.6 0 4 1.7 4 3.8zM12 12c2.6 0 4-1.7 4-3.8-2.6 0-4 1.7-4 3.8zM12 16.8c-2.6 0-4-1.7-4-3.8 2.6 0 4 1.7 4 3.8zM12 16.8c2.6 0 4-1.7 4-3.8-2.6 0-4 1.7-4 3.8zM12 7.5c-1.3-1.1-1.3-2.9 0-4.5 1.3 1.6 1.3 3.4 0 4.5z"/>',
  cloudCheck: '<path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.8 4.4 4.4 0 0 0 7.5 18.5z"/><path d="M9.5 13.8l2 2 3.5-3.6"/>',
  arrIn: '<path d="M17 7L7 17M15 17H7V9"/>',
  arrOut: '<path d="M7 17L17 7M9 7h8v8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  coins: '<circle cx="9" cy="9" r="5.5"/><path d="M15.2 9.8a5.5 5.5 0 1 1-5.4 5.4"/>',
  refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 5.6 7.5M4.5 4v4h4M4.5 13a7.5 7.5 0 0 0 13.9 3.5M19.5 20v-4h-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6 6 0 0 1 3.5 5.8"/>',
  building: '<rect x="4.5" y="3" width="15" height="18" rx="1.5"/><path d="M8.5 7h2M13.5 7h2M8.5 11h2M13.5 11h2M8.5 15h2M13.5 15h2"/>',
  chat: '<path d="M4 5h16v11H9.5L4 20z"/>',
  clipCheck: '<path d="M9 3.5h6v3H9z"/><path d="M7 5H5.5v15.5h13V5H17"/><path d="M9 13.5l2 2 4-4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  dots: '<circle cx="5.5" cy="12" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="18.5" cy="12" r="1.25"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5H17a3.5 3.5 0 0 0 3.5-3.5c0-4.3-3.8-7.7-8.5-7.7z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.3" r="1"/><circle cx="15" cy="7.6" r="1"/>',
  scale: '<path d="M12 4v16M6 20h12M5 8h14M5 8l-2.5 6a2.5 2.5 0 0 0 5 0zM19 8l-2.5 6a2.5 2.5 0 0 0 5 0z"/>'
};
const WA = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z';

const sprite = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' +
  Object.entries(P).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') +
  `<symbol id="i-wa" viewBox="0 0 24 24"><path d="${WA}"/></symbol></svg>`;

const ic = (name, cls = '') => name === 'wa'
  ? `<svg class="i i-fill ${cls}" aria-hidden="true"><use href="#i-wa"/></svg>`
  : `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

module.exports = { sprite, ic, names: Object.keys(P).concat('wa'), bytes: Buffer.byteLength(sprite) };
