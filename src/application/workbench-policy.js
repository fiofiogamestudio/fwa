import { normalizeEffectPattern } from '../core/effects.js';
import { resolveNodeEffects } from '../core/refs.js';

export function assertProjectWorkScope(node, refs = []) {
  const effects = resolveNodeEffects(node, refs);
  for (const value of effects.writes) {
    const pattern = normalizeEffectPattern(value);
    const first = pattern.split('/')[0];
    // A wildcard in the root component could match fw/ or internal state.
    // Require a concrete first component, then enforce actual writes normally.
    if (first.toLowerCase() === 'fw' || /[?*]/.test(first)) {
      throw Object.assign(new Error(`Write scope ${pattern} can affect protected framework modules. Split it into explicit project paths outside fw/.`), { code: 'workbench-protected-scope' });
    }
  }
  return effects;
}
