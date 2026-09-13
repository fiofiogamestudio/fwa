(function () {
  // Domain-only CSS: ordinary layout, controls and colors belong to FWE Surface.
  if (document.getElementById('fwa-workbench-style')) return;
  const style = document.createElement('style');
  style.id = 'fwa-workbench-style';
  style.textContent = `
  [data-fwa-graph]{height:500px;min-height:300px;position:relative}
  .fwa-artifact-media,.fwa-library-media,[data-testid=fwa-artifact-media],.fwa-ref-preview img{display:block;max-width:100%;max-height:500px;object-fit:contain}
  [data-testid=fwa-reference-drop][data-drag=true]{outline:2px dashed var(--accent);outline-offset:-2px}
  .fwa-document{overflow-wrap:anywhere;line-height:1.7}
  .fwa-document pre,.fwa-diff{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
  .fwa-diff span{display:block;white-space:pre-wrap}
  .fwa-diff-add{color:var(--green);background:color-mix(in srgb,var(--green) 10%,transparent)}
  .fwa-diff-remove{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
  .fwa-diff-hunk{color:var(--accent)}
  @media(max-width:700px){[data-fwa-graph]{height:370px}}
  `;
  document.head.append(style);
}());
