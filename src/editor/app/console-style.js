(function () {
  // Domain-only CSS: ordinary layout, controls and colors belong to FWE Surface.
  if (document.getElementById('fwa-workbench-style')) return;
  const style = document.createElement('style');
  style.id = 'fwa-workbench-style';
  style.textContent = `
  [data-fwa-graph]{height:52vh;min-height:360px;position:relative}
  [data-fwa-layout=workspace]{grid-template-columns:minmax(0,1.65fr) minmax(310px,1fr);align-items:start}
  [data-fwa-pane=graph]{position:sticky;top:8px;min-width:0}
  [data-fwa-pane=inspector]{min-width:0;max-height:75vh;overflow:auto}
  .fwa-artifact-media,.fwa-library-media,[data-testid=fwa-artifact-media],.fwa-ref-preview img{display:block;max-width:100%;max-height:500px;object-fit:contain}
  [data-testid=fwa-reference-drop][data-drag=true]{outline:2px dashed var(--accent);outline-offset:-2px}
  .fwa-document{overflow-wrap:anywhere;line-height:1.7}
  .fwa-document pre,.fwa-diff{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
  .fwa-diff span{display:block;white-space:pre-wrap}
  .fwa-diff-add{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}
  .fwa-diff-remove{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
  .fwa-diff-hunk{color:var(--accent)}
  @media(max-width:1100px){[data-fwa-layout=workspace]{grid-template-columns:minmax(0,1fr)}[data-fwa-pane=graph]{position:static}[data-fwa-pane=inspector]{max-height:none}}
  `;
  document.head.append(style);
}());
