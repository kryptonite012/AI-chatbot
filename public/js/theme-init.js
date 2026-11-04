// Runs before first paint to avoid a flash of the wrong theme.
(function () {
  var theme = 'system';
  try {
    var prefs = JSON.parse(localStorage.getItem('sangam.prefs') || '{}');
    if (prefs && prefs.theme) theme = prefs.theme;
  } catch (e) {}
  if (theme === 'system') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
