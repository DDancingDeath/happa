// Theme registry (Phase 2 ships this as www/js/ui/themes.js). Adding a theme = one CSS file + one entry + 2 i18n keys.
// kind: 'both' = has light + dark variants; 'dark' = always dark (Appearance Light/System is remembered but not applied).
module.exports = [
  { id: 'modern', name: 'Modern Minimal', desc: 'Clean, quiet and professional. The default.', kind: 'both' },
  { id: 'vintage', name: 'Vintage', desc: 'Warm paper, sepia ink, serif headings.', kind: 'both' },
  { id: 'classic', name: 'Classic', desc: 'Navy masthead, crisp white, ruled and formal.', kind: 'both' },
  { id: 'nordic', name: 'Nordic', desc: 'Light, airy and calm. Soft borderless panels.', kind: 'both' },
  { id: 'glass', name: 'Glassmorphism', desc: 'Frosted layers over a soft colour mesh.', kind: 'both' },
  { id: 'material', name: 'Material', desc: 'Tonal surfaces, pill buttons, filled fields.', kind: 'both' },
  { id: 'fluent', name: 'Fluent', desc: 'Windows 11 feel: Mica canvas, crisp controls.', kind: 'both' },
  { id: 'dark', name: 'Dark', desc: 'Monochrome charcoal. Colour only where it means something.', kind: 'dark' },
  { id: 'midnight', name: 'Midnight', desc: 'Deep navy night with a sky-blue accent.', kind: 'dark' },
  { id: 'nature', name: 'Nature', desc: 'Oat, moss and clay. Soft organic corners.', kind: 'both' },
  { id: 'cyberpunk', name: 'Cyberpunk', desc: 'Neon on black, mono figures, cut corners.', kind: 'dark' },
  { id: 'premium', name: 'Premium', desc: 'Ivory, ink and gold with elegant serif figures.', kind: 'both' }
];
