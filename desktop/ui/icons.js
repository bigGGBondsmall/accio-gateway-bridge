/* Accio Bridge — inline SVG icon set (24x24 grid, stroke icons).
   Only static author-written markup is used here; no runtime data is ever
   interpolated into these strings. */
window.AB = window.AB || {};

(function (AB) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  /* body markup + whether the shape is filled instead of stroked */
  var ICONS = {
    brand: { fill: true, body: '<path d="M13.6 2 4 13.4h5.7L9 22l9.8-11.6h-5.9z"/>' },
    overview: { body: '<path d="M4 18.5a9 9 0 1 1 16 0"/><path d="M12 18.2l4.4-5.6"/><circle cx="12" cy="18.5" r="1.3"/>' },
    providers: { body: '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 7.2h.01M7 16.8h.01"/>' },
    models: { body: '<path d="M12 3.2l8 4.4v9L12 21l-8-4.4v-9l8-4.4z"/><path d="M12 12.1l8-4.4M12 12.1V21M12 12.1L4 7.7"/>' },
    gateway: { body: '<path d="M3 12h3.4l3-6.2 4.2 12.4 2.6-6.2H21"/>' },
    logs: { body: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.4" cy="6" r="1.1"/><circle cx="4.4" cy="12" r="1.1"/><circle cx="4.4" cy="18" r="1.1"/>' },
    test: { body: '<circle cx="12" cy="12" r="8.6"/><path d="M10 8.4l6 3.6-6 3.6z"/>' },
    settings: { body: '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.6a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.5 14.6a1.65 1.65 0 0 0-1.51-1.08H2.9a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.5 9.44a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3.4a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
    plus: { body: '<path d="M12 5v14M5 12h14"/>' },
    minus: { body: '<path d="M5 12h14"/>' },
    refresh: { body: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.2V9h-4.8"/>' },
    copy: { body: '<rect x="9" y="9" width="11.5" height="11.5" rx="2"/><path d="M6.5 15H5.2a2 2 0 0 1-2-2V5.2a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v1.3"/>' },
    check: { body: '<path d="M4.5 12.6l5 5L20 6.8"/>' },
    checkCircle: { body: '<circle cx="12" cy="12" r="8.6"/><path d="M8 12.4l2.8 2.8L16 9.6"/>' },
    x: { body: '<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6"/>' },
    alert: { body: '<path d="M12 4.2 2.6 20.2h18.8L12 4.2z"/><path d="M12 10v4.4M12 17.4h.01"/>' },
    info: { body: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2V16.4M12 8h.01"/>' },
    folder: { body: '<path d="M3 7.6A2 2 0 0 1 5 5.6h3.9l1.8 2.1H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' },
    external: { body: '<path d="M14 4.2h5.8V10"/><path d="M19.8 4.2 11 13"/><path d="M18.4 14.2v4.6a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2V7.6a2 2 0 0 1 2-2h4.6"/>' },
    trash: { body: '<path d="M4 7.2h16"/><path d="M9.4 7.2V4.9h5.2v2.3"/><path d="M6.6 7.2l.8 12.4c0 .5.5.9 1 .9h7.2c.5 0 1-.4 1-.9l.8-12.4"/>' },
    edit: { body: '<path d="M4 20.2h3.9L19 9.1a1.9 1.9 0 0 0 0-2.7l-1.4-1.4a1.9 1.9 0 0 0-2.7 0L3.8 16.1z"/><path d="M14.6 5.4l4 4"/>' },
    search: { body: '<circle cx="11" cy="11" r="6.4"/><path d="M15.6 15.6 20.6 20.6"/>' },
    eye: { body: '<path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="3"/>' },
    eyeOff: { body: '<path d="M3.4 3.4l17.2 17.2"/><path d="M10.2 6.1A9.9 9.9 0 0 1 12 6c6 0 9.6 6 9.6 6a17.6 17.6 0 0 1-3.4 4.1"/><path d="M6.2 7.8A17.4 17.4 0 0 0 2.4 12s3.6 6 9.6 6a9.6 9.6 0 0 0 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>' },
    star: { body: '<path d="M12 3.9l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17.3 6.7 20l1-5.8L3.5 10l5.9-.9z"/>' },
    chevronRight: { body: '<path d="M9.2 5l7 7-7 7"/>' },
    chevronDown: { body: '<path d="M5 9.2l7 7 7-7"/>' },
    chevronUp: { body: '<path d="M5 14.8l7-7 7 7"/>' },
    play: { body: '<path d="M7 4.6 19.5 12 7 19.4z"/>' },
    stop: { body: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="1.6"/>' },
    power: { body: '<path d="M12 3.4v8.4"/><path d="M7.4 6.6a7.2 7.2 0 1 0 9.2 0"/>' },
    pause: { body: '<path d="M9.2 5v14M14.8 5v14"/>' },
    hide: { body: '<rect x="3.6" y="5.4" width="16.8" height="10.2" rx="1.6"/><path d="M12 15.6v4.8M8.8 20.4h6.4"/>' },
    quit: { body: '<path d="M14.6 4.2h3.2a2 2 0 0 1 2 2v11.6a2 2 0 0 1-2 2h-3.2"/><path d="M9.4 12h10.4"/><path d="M13.4 8.2 17.2 12l-3.8 3.8"/>' },
    arrowDown: { body: '<path d="M12 4.4v11.8"/><path d="M7.4 11.6 12 16.2l4.6-4.6"/><path d="M4.4 20h15.2"/>' },
    download: { body: '<path d="M12 3.6v9.6"/><path d="M8.2 9.6 12 13.4l3.8-3.8"/><path d="M4.6 15.6v2.8c0 .9.7 1.6 1.6 1.6h11.6c.9 0 1.6-.7 1.6-1.6v-2.8"/>' },
    clock: { body: '<circle cx="12" cy="12" r="8.6"/><path d="M12 6.8v5.6l3.6 2.1"/>' },
    speed: { body: '<path d="M4.6 18.4a9 9 0 1 1 14.8 0"/><path d="M12 13.6l3.6-4"/><circle cx="12" cy="15.4" r="1.1"/>' },
    plug: { body: '<path d="M9 3.4v5M15 3.4v5"/><path d="M6.6 8.4h10.8v3a5.4 5.4 0 0 1-10.8 0z"/><path d="M12 16.8v3.8"/>' },
    layers: { body: '<path d="M12 3.4 3.4 8 12 12.6 20.6 8z"/><path d="M3.4 12.8 12 17.4l8.6-4.6"/><path d="M3.4 16.8 12 21.4l8.6-4.6"/>' },
    box: { body: '<rect x="3.6" y="3.6" width="16.8" height="16.8" rx="2.4"/><path d="M9 3.6v16.8M3.6 9.6h16.8"/>' },
    dot: { fill: true, body: '<circle cx="12" cy="12" r="4"/>' }
  };

  /* Returns a fresh <svg> element. `name` falls back to the neutral dot. */
  function icon(name, size) {
    var def = ICONS[name] || ICONS.dot;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    svg.setAttribute('fill', def.fill ? 'currentColor' : 'none');
    svg.setAttribute('stroke', def.fill ? 'none' : 'currentColor');
    svg.setAttribute('stroke-width', def.fill ? '0' : '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = def.body; /* static author markup only */
    return svg;
  }

  icon.has = function (name) { return !!ICONS[name]; };

  AB.icon = icon;
})(window.AB);