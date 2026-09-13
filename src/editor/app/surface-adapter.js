(function () {
  'use strict';
  let context;
  function configure(ctx) {
    if (!window.fwe.ui.createSurface || !ctx.app.labels?.fwaConsole?.uiConfigs || !ctx.domain.model?.fields) {
      throw new Error('FWA 需要包含配置化 Surface 和权威字段模型的 FWE。请重启服务并刷新。');
    }
    context = ctx;
  }
  function config(name) {
    const value = context?.app.labels.fwaConsole.uiConfigs[name];
    if (!value) throw new Error(`Missing FWA surface configuration: ${name}`);
    return value;
  }
  function create(name, bindings = {}) {
    const fields = context.domain.model.fields;
    return window.fwe.ui.createSurface(config(name), { ...bindings, resolveField(path) {
      if (!Object.prototype.hasOwnProperty.call(fields, path)) throw new Error(`Unknown FWA contract field: ${path}`);
      return fields[path];
    } });
  }
  function resourceLink(type, id, label, options = {}) {
    const link = window.FwaNavigation.link(type, id, { label, target: options.target || '_blank', goalId: options.goalId });
    // Local selection preserves in-flight drafts; modified clicks retain the
    // native FWE resource URL and open an independently restorable view.
    if (options.onSelect) link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); options.onSelect();
    });
    return link;
  }
  function importLimits() { return context?.app.labels.fwaConsole.importLimits; }
  function interactionLimits() { return context?.app.labels.fwaConsole.interactionLimits; }
  window.FwaSurface = { configure, config, create, resourceLink, importLimits, interactionLimits };
}());
