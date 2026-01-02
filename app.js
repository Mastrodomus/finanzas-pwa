if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/finanzas-pwa/sw.js");
  });
}
const ing = document.getElementById("ing");
const egr = document.getElementById("egr");
const out = document.getElementById("out");

document.getElementById("btn").addEventListener("click", () => {
  const ingresos = Number(ing.value || 0);
  const egresos  = Number(egr.value || 0);
  const fcff = ingresos - egresos;

  out.textContent = JSON.stringify({ fcff }, null, 2);
});
