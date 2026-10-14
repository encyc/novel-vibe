// The shell's recovery watchdog navigates here with the stalled origin in
// the URL fragment, so "重新连接" returns to exactly where the app was.
document.querySelector("#retry").addEventListener("click", () => {
  var target = window.location.hash.startsWith("#")
    ? window.decodeURIComponent(window.location.hash.slice(1))
    : "";
  window.location.assign(target || "https://app.lingqiai.art");
});
