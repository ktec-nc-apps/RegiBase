/* The Vue 3 runtime we load is the "global" build, which publishes window.Vue.
 * Third-party bundles inside Nextcloud core auto-install into that global — vue-resize
 * (in core-common.js) runs `window.Vue.use(...)`, which is Vue 2 API and throws on the
 * Vue 3 namespace, breaking the user-status menu on our pages. So take our copy private
 * again and leave window.Vue exactly as we found it. */
(function () {
  'use strict';
  window.__RegiBaseVue = window.Vue;
  if (Object.prototype.hasOwnProperty.call(window, '__vueGlobalBeforeRegiBase')) {
    window.Vue = window['__vueGlobalBeforeRegiBase'];
  } else {
    try { delete window.Vue; } catch (e) { window.Vue = undefined; }
  }
})();
