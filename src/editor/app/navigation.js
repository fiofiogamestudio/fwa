(function () {
  'use strict';
  const collections = new Set(['nodes', 'refs', 'runs', 'changeSets', 'evidence', 'goals', 'groups', 'evaluations', 'integrations', 'reversions']);
  function segment(value) {
    if (typeof value !== 'string' || !value || value !== value.trim()) throw new Error('A resource identity is required.');
    return encodeURIComponent(value);
  }
  function target(type, id, options = {}) {
    if (!collections.has(type)) throw new Error('Unknown FWA object collection.');
    const scope = type === 'groups' ? `${segment(options.goalId)}/` : '';
    return { domainId: 'fwa-projection', fileName: `objects/${type}/${scope}${segment(id)}.json` };
  }
  function href(type, id, options = {}) {
    if (typeof window.fwe?.navigation?.href !== 'function') throw new Error('FWE resource navigation is unavailable.');
    return window.fwe.navigation.href(target(type, id, options));
  }
  function link(type, id, options = {}) {
    if (typeof window.fwe?.ui?.createResourceLink !== 'function') throw new Error('FWE resource links are unavailable.');
    return window.fwe.ui.createResourceLink({ ...options, navigation: target(type, id, options), label: options.label ?? id });
  }
  window.FwaNavigation = Object.freeze({ target, href, link });
})();
