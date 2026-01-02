// PWA offline
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/finanzas-pwa/sw.js");
  });
}

// DOM
const ing = document.getElementById("ing");
const egr = document.getElementById("egr");
const out = document.getElementById("out");

const scName = document.getElementById("scName");
const scList = document.getElementById("scList");

const btnCalc = document.getElementById("btn");
const btnSave = document.getElementById("saveSc");
const btnNew  = document.getElementById("newSc");
const btnLoad = document.getElementById("loadSc");
const btnDel  = document.getElementById("delSc");

// Storage keys
const INDEX_KEY = "finanzas.scenarios.index"; // array de nombres
const DATA_PREFIX = "finanzas.scenario.";     // finanzas.scenario.<name>

// Helpers
function safeName(name) {
  return (name || "").trim();
}

function getIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]");
  } catch {
    return [];
  }
}

function setIndex(arr) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(arr));
}

function refreshScenarioList(selected = "") {
  const names = getIndex().sort((a, b) => a.localeCompare(b));
  scList.innerHTML = "";

  if (names.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(sin escenarios)";
    scList.appendChild(opt);
    return;
  }

  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    if (n === selected) opt.selected = true;
    scList.appendChild(opt);
  }
}

function calc() {
  const ingresos = Number(ing.value || 0);
  const egresos  = Number(egr.value || 0);
  const fcff = ingresos - egresos;
  out.textContent = JSON.stringify({ fcff }, null, 2);
  return { ingresos, egresos, fcff };
}

// Actions
btnCalc.addEventListener("click", () => {
  calc();
});

btnNew.addEventListener("click", () => {
  ing.value = "";
  egr.value = "";
  scName.value = "";
  out.textContent = "";
  ing.focus();
});

btnSave.addEventListener("click", () => {
  const name = safeName(scName.value);
  if (!name) {
    alert("Poné un nombre de escenario.");
    scName.focus();
    return;
  }

  const payload = {
    ingresos: Number(ing.value || 0),
    egresos: Number(egr.value || 0),
    savedAt: new Date().toISOString()
  };

  // guardar data
  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(payload));

  // actualizar index
  const idx = new Set(getIndex());
  idx.add(name);
  setIndex([...idx]);

  refreshScenarioList(name);
  calc();
});

btnLoad.addEventListener("click", () => {
  const name = scList.value;
  if (!name) return;

  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) {
    alert("No se encontró el escenario (puede haber quedado desincronizado).");
    return;
  }

  const data = JSON.parse(raw);
  ing.value = data.ingresos ?? "";
  egr.value = data.egresos ?? "";
  scName.value = name;
  calc();
});

btnDel.addEventListener("click", () => {
  const name = scList.value;
  if (!name) return;

  const ok = confirm(`Eliminar escenario "${name}"?`);
  if (!ok) return;

  localStorage.removeItem(DATA_PREFIX + name);

  const idx = getIndex().filter((n) => n !== name);
  setIndex(idx);

  refreshScenarioList("");
  out.textContent = "";
});

// Init
refreshScenarioList();
