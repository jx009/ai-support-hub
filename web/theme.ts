const colorTokens = [
  'primary-color', 'primary-hover', 'primary-active', 'primary-bg', 'primary-bg-hover', 'primary-border',
  'text-primary', 'text-secondary', 'text-tertiary', 'text-heading',
  'bg-container', 'bg-layout', 'bg-gray', 'bg-elevated', 'bg-mask',
  'border-color', 'border-light', 'error-color', 'success-color', 'warning-color',
];
const properties: Record<string, string> = {
  ...Object.fromEntries(colorTokens.map((key) => [key, 'color'])),
  'font-family': 'font-family', 'font-size': 'font-size', 'font-size-sm': 'font-size',
  'font-size-lg': 'font-size', 'font-size-xl': 'font-size', 'line-height': 'line-height',
  'border-radius': 'border-radius', 'border-radius-lg': 'border-radius',
  'control-height': 'height', 'shadow-1': 'box-shadow', 'shadow-card': 'box-shadow',
};

// Only called after the parent window and embedding origin have been verified.
export function applySupportTheme(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const theme = value as { mode?: unknown; tokens?: Record<string, unknown> };
  if (theme.mode !== 'light' && theme.mode !== 'dark') return;
  const root = document.documentElement;
  root.dataset.supportTheme = theme.mode;
  for (const [name, property] of Object.entries(properties)) {
    const token = theme.tokens?.[name];
    if (typeof token === 'string' && token.length <= 512 &&
      !/[;{}<>]|url\s*\(|var\s*\(/i.test(token) && CSS.supports(property, token)) {
      root.style.setProperty('--' + name, token);
    } else {
      root.style.removeProperty('--' + name);
    }
  }
}
