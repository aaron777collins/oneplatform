// Theme detection runs before React hydrates to prevent a flash of the wrong
// theme. Loaded as an external script so no inline-script CSP hash is needed.
(function () {
  var theme = localStorage.getItem("op-theme");
  if (
    theme === "dark" ||
    (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
