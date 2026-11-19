// Применяет сохранённую тему до первой отрисовки, чтобы не было вспышки.
(function () {
  try {
    var t = localStorage.getItem("kampus.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) { /* хранилище недоступно — используем системную тему */ }
})();
