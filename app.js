/* app.js — versión “todo incluido” (offline)
   Incluye:
   - Inputs / Resultados / Comparación / JSON (UI autogenerada)
   - Calcular + Reset (robusto)
   - Escenarios: guardar / cargar / eliminar + LOCK (bloquear edición accidental)
   - CapEx multi-mes (tabla dinámica)
   - Export CSV (tabla mensual + KPIs)
   - Sensibilidad (tornado simple) sobre VAN/TIR/DSCR/Buffer (por defecto VAN)
   - Comparación A vs B + Base vs Multi (deltas de KPIs)

   Requisito en index.html (orden):
     <script src="engine.js"></script>
     <script src="app.js"></script>
*/

"use strict";

/* --------------------------
   0) Service Worker (opcional)
---------------------------*/
(function registerSW() {
  try {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }
  } catch (_) {}
})();

/* --------------------------
   1) DEFAULT_STATE (EN CERO)
   Nota: dejamos horizon_months = 60 como default de UI; todo lo demás 0.
---------------------------*/
const DEFAULT_STATE = {
  project: { name: "", start_yyyymm: "", horizon_months: 60, tax_rate: 0.0 },
  rev: {
    volume_0: 0.0,
    volume_growth_m: 0.0,
    capacity_max: 0.0,
    collection_factor: 0.0,
    price_0: 0.0,
    price_growth_m: 0.0,
  },
  cost: {
    fixed_0: 0.0,
    fixed_growth_m: 0.0,
    var_unit_0: 0.0,
    var_unit_growth_m: 0.0,
    maintenance_0: 0.0,
    maintenance_growth_m: 0.0,
  },
  wc: { enabled: false, dso: 0, dpo: 0, dio: 0, ap_fixed_share: 0.0 },
  wacc: { e_pct: 0.0, d_pct: 0.0, rf: 0.0, mrp: 0.0, beta: 0.0, spread: 0.0, tax_rate: 0.0 },
  capex: [{ month_index: 0, item: "Inversión inicial", amount: 0.0 }],
  fin: {
    enabled: false,
    debt_amount_0: 0.0,
    interest_rate_annual: 0.0,
    term_months: 60,
    grace_months: 0,
    amortization_type: "french",
    tax_shield_enabled: false,
  },
};

/* --------------------------
   2) Storage
---------------------------*/
const INDEX_KEY = "finanzas.scenarios.index.v4";
const DATA_PREFIX = "finanzas.scenario.v4.";
const LAST_STATE_KEY = "finanzas.lastState.v4";
const LAST_TAB_KEY = "finanzas.lastTab.v4";

/* --------------------------
   3) Helpers
---------------------------*/
const isFiniteNum = (x) => Number.isFinite(x) && !Number.isNaN(x);
const deepClone = (x) => JSON.parse(JSON.stringify(x));
const safeName = (s) => String(s || "").trim();

function fmtMoney(x) {
  if (!isFiniteNum(x)) return "N/D";
  return x.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(x) {
  if (!isFiniteNum(x)) return "N/D";
  return (x * 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}
function byId(id) { return document.getElementById(id); }

function section(title, children = []) {
  return el("div", {
    style: { border: "1px solid #ddd", borderRadius: "10px", padding: "12px", marginBottom: "12px" }
  }, [
    el("div", { style: { fontWeight: "700", marginBottom: "8px" } }, [title]),
    ...children
  ]);
}
function grid(children = []) {
  return el("div", {
    style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }
  }, children);
}
function field(label, id, type = "number", step = "any", placeholder = "") {
  return el("label", { style: { display: "grid", gap: "6px", fontSize: "13px" } }, [
    el("span", { style: { fontWeight: "600" } }, [label]),
    el("input", { id, type, step, placeholder })
  ]);
}
function checkbox(label, id) {
  return el("label", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" } }, [
    el("input", { id, type: "checkbox" }),
    el("span", { style: { fontWeight: "600" } }, [label])
  ]);
}
function selectField(label, id, options) {
  const sel = el("select", { id });
  for (const { value, text } of options) sel.appendChild(el("option", { value }, [text]));
  return el("label", { style: { display: "grid", gap: "6px", fontSize: "13px" } }, [
    el("span", { style: { fontWeight: "600" } }, [label]),
    sel
  ]);
}

/* --------------------------
   4) Escenarios storage
---------------------------*/
function getIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]"); } catch { return []; }
}
function setIndex(arr) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(arr));
}
function getScenarioPayloadByName(name) {
  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function getScenarioStateByName(name) {
  const p = getScenarioPayloadByName(name);
  if (!p || !p.S) return null;
  return p.S;
}
function isScenarioLocked(name) {
  const p = getScenarioPayloadByName(name);
  return !!(p && p.meta && p.meta.locked);
}
function setScenarioLock(name, locked) {
  const p = getScenarioPayloadByName(name);
  if (!p) return;
  p.meta = p.meta || {};
  p.meta.locked = !!locked;
  p.meta.lockedAt = new Date().toISOString();
  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(p));
}

/* --------------------------
   5) Persistencia “último estado”
---------------------------*/
function saveLastState(S) {
  try { localStorage.setItem(LAST_STATE_KEY, JSON.stringify({ S, at: new Date().toISOString() })); } catch {}
}
function loadLastState() {
  try {
    const raw = localStorage.getItem(LAST_STATE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.S ? p.S : null;
  } catch { return null; }
}
function saveLastTab(tab) {
  try { localStorage.setItem(LAST_TAB_KEY, String(tab)); } catch {}
}
function loadLastTab() {
  try { return localStorage.getItem(LAST_TAB_KEY) || "inputs"; } catch { return "inputs"; }
}

/* --------------------------
   6) UI base
---------------------------*/
function ensureUI() {
  let root = byId("appRoot");
  if (root) return root;

  root = el("div", {
    id: "appRoot",
    style: { maxWidth: "1150px", margin: "0 auto", padding: "16px", fontFamily: "system-ui, Segoe UI, Arial" }
  });

  const topBar = el("div", {
    style: { display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }
  }, [
    el("div", {}, [
      el("div", { style: { fontSize: "20px", fontWeight: "800" } }, ["Modelo de inversión (offline)"]),
      el("div", { style: { fontSize: "12px", opacity: "0.8" } }, ["FCFF + WACC + (opcional) deuda/FCFE/DSCR/buffer"])
    ]),
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, [
      el("button", { id: "btnCalc", type: "button" }, ["Calcular"]),
      el("button", { id: "btnReset", type: "button" }, ["Reset (a cero)"]),
    ])
  ]);

  const tabs = el("div", { style: { display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" } }, [
    el("button", { id: "tabInputs", type: "button" }, ["Inputs"]),
    el("button", { id: "tabResults", type: "button" }, ["Resultados"]),
    el("button", { id: "tabCompare", type: "button" }, ["Comparación"]),
    el("button", { id: "tabJSON", type: "button" }, ["JSON"]),
  ]);

  const msg = el("div", { id: "msgBox", style: { marginBottom: "12px" } });

  const viewInputs = el("div", { id: "view_inputs" });
  const viewResults = el("div", { id: "view_results", style: { display: "none" } });
  const viewCompare = el("div", { id: "view_compare", style: { display: "none" } });
  const viewJSON = el("div", { id: "view_json", style: { display: "none" } });

  root.appendChild(topBar);
  root.appendChild(tabs);
  root.appendChild(msg);
  root.appendChild(viewInputs);
  root.appendChild(viewResults);
  root.appendChild(viewCompare);
  root.appendChild(viewJSON);

  document.body.appendChild(root);

  buildInputsView(viewInputs);
  buildResultsView(viewResults);
  buildCompareView(viewCompare);
  buildJSONView(viewJSON);

  function activate(tab) {
    viewInputs.style.display = tab === "inputs" ? "" : "none";
    viewResults.style.display = tab === "results" ? "" : "none";
    viewCompare.style.display = tab === "compare" ? "" : "none";
    viewJSON.style.display = tab === "json" ? "" : "none";
    saveLastTab(tab);

    if (tab === "compare") refreshCompareUI();
  }

  byId("tabInputs").addEventListener("click", () => activate("inputs"));
  byId("tabResults").addEventListener("click", () => activate("results"));
  byId("tabCompare").addEventListener("click", () => activate("compare"));
  byId("tabJSON").addEventListener("click", () => activate("json"));

  activate(loadLastTab());
  return root;
}

/* --------------------------
   7) Views
---------------------------*/
function buildInputsView(host) {
  // --- Escenarios
  const scName = el("input", { id: "scName", type: "text", placeholder: "Ej: Base", style: { width: "220px" } });
  const scList = el("select", { id: "scList", style: { width: "240px" } });

  const scRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [
    el("span", { style: { fontWeight: "800" } }, ["Escenarios"]),
    scName,
    el("button", { id: "btnSaveSc", type: "button" }, ["Guardar"]),
    el("button", { id: "btnNewSc", type: "button" }, ["Nuevo"]),
    el("span", { style: { marginLeft: "8px" } }, ["Cargar:"]),
    scList,
    el("button", { id: "btnLoadSc", type: "button" }, ["Cargar"]),
    el("button", { id: "btnDelSc", type: "button" }, ["Eliminar"]),
    el("button", { id: "btnLockSc", type: "button" }, ["Lock/Unlock"]),
    el("span", { id: "scLockBadge", style: { fontSize: "12px", opacity: "0.85", marginLeft: "6px" } }, [""])
  ]);

  // --- Proyecto
  const secProject = section("1) Proyecto", [
    grid([
      field("Nombre", "project_name", "text", "any", "Ej: Proyecto X"),
      field("Inicio (YYYY-MM)", "start_yyyymm", "text", "any", "Ej: 2026-01"),
      field("Horizonte (meses)", "horizon_months", "number", "1"),
      field("Impuesto (tasa 0..0.6)", "tax_rate", "number", "0.01"),
    ])
  ]);

  // --- Ingresos
  const secRev = section("2) Ingresos", [
    grid([
      field("Volumen inicial (mes)", "volume_0", "number", "1"),
      field("Crec. volumen mensual", "volume_growth_m", "number", "0.0001"),
      field("Capacidad máxima (mes)", "capacity_max", "number", "1"),
      field("Factor cobranza (0..1)", "collection_factor", "number", "0.01"),
      field("Precio inicial (USD)", "price_0", "number", "0.01"),
      field("Ajuste precio mensual", "price_growth_m", "number", "0.0001"),
    ])
  ]);

  // --- Costos
  const secCost = section("3) Costos", [
    grid([
      field("Fijos iniciales (USD/mes)", "fixed_0", "number", "1"),
      field("Ajuste fijos mensual", "fixed_growth_m", "number", "0.0001"),
      field("Variable unitario (USD/u)", "var_unit_0", "number", "0.01"),
      field("Ajuste variable mensual", "var_unit_growth_m", "number", "0.0001"),
      field("Mantenimiento (USD/mes)", "maintenance_0", "number", "0.01"),
      field("Ajuste mantenimiento mensual", "maintenance_growth_m", "number", "0.0001"),
    ])
  ]);

  // --- WC
  const secWC = section("4) Capital de trabajo (DSO/DPO/DIO)", [
    el("div", { style: { marginBottom: "8px" } }, [checkbox("Habilitar WC", "wc_enabled")]),
    grid([
      field("DSO", "dso", "number", "1"),
      field("DPO", "dpo", "number", "1"),
      field("DIO", "dio", "number", "1"),
      field("% fijos elegibles en AP (0..1)", "ap_fixed_share", "number", "0.01"),
    ])
  ]);

  // --- WACC
  const secWACC = section("5) WACC (manual)", [
    grid([
      field("E% (0..1)", "e_pct", "number", "0.01"),
      field("D% (0..1)", "d_pct", "number", "0.01"),
      field("Rf anual", "rf", "number", "0.0001"),
      field("MRP anual", "mrp", "number", "0.0001"),
      field("Beta", "beta", "number", "0.01"),
      field("Spread deuda", "spread", "number", "0.0001"),
      field("Tasa impuesto (WACC)", "wacc_tax_rate", "number", "0.01"),
    ]),
    el("div", { id: "waccCaption", style: { marginTop: "8px", fontSize: "12px", opacity: "0.85" } }, [""])
  ]);

  // --- CapEx multi-mes
  const secCapex = section("6) CapEx (multi-mes)", [
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" } }, [
      el("button", { id: "btnCapexAdd", type: "button" }, ["+ Agregar fila"]),
      el("button", { id: "btnCapexClear", type: "button" }, ["Limpiar (solo mes 0)"]),
      el("span", { style: { fontSize: "12px", opacity: "0.85" } }, ["(month_index: 0 = inversión inicial)"])
    ]),
    el("div", { id: "capexTableHost", style: { overflow: "auto", border: "1px solid #ddd", borderRadius: "10px" } })
  ]);

  // --- Deuda
  const secFin = section("7) Financiamiento (opcional)", [
    el("div", { style: { marginBottom: "8px" } }, [checkbox("Usar deuda", "fin_enabled")]),
    grid([
      field("Deuda inicial D0 (USD)", "debt_amount_0", "number", "1"),
      field("Tasa anual deuda", "interest_rate_annual", "number", "0.0001"),
      field("Plazo deuda (meses)", "term_months", "number", "1"),
      field("Gracia (meses, solo interés)", "grace_months", "number", "1"),
      selectField("Sistema", "amortization_type", [
        { value: "french", text: "french" },
        { value: "german", text: "german" },
      ]),
    ]),
    el("div", { style: { marginTop: "8px" } }, [checkbox("Escudo fiscal (interés)", "tax_shield_enabled")])
  ]);

  host.appendChild(scRow);
  host.appendChild(el("div", { style: { height: "10px" } }));
  host.appendChild(secProject);
  host.appendChild(secRev);
  host.appendChild(secCost);
  host.appendChild(secWC);
  host.appendChild(secWACC);
  host.appendChild(secCapex);
  host.appendChild(secFin);
}

function buildResultsView(host) {
  const kpiGrid = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px" } });
  function kpiCard(title, id) {
    return el("div", { style: { border: "1px solid #ddd", borderRadius: "10px", padding: "12px" } }, [
      el("div", { style: { fontSize: "12px", opacity: "0.8", marginBottom: "6px" } }, [title]),
      el("div", { id, style: { fontSize: "18px", fontWeight: "900" } }, ["–"]),
    ]);
  }

  kpiGrid.appendChild(kpiCard("VAN (USD)", "r_van"));
  kpiGrid.appendChild(kpiCard("TIR mensual", "r_tir_m"));
  kpiGrid.appendChild(kpiCard("TIR anual eq.", "r_tir_a"));
  kpiGrid.appendChild(kpiCard("WACC anual", "r_wacc_a"));
  kpiGrid.appendChild(kpiCard("WACC mensual", "r_wacc_m"));
  kpiGrid.appendChild(kpiCard("Payback (mes)", "r_pb"));
  kpiGrid.appendChild(kpiCard("Payback desc. (mes)", "r_dpb"));

  const kpiGrid2 = el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px", marginTop: "10px" } });
  kpiGrid2.appendChild(kpiCard("TIR Equity anual eq.", "r_irr_e_a"));
  kpiGrid2.appendChild(kpiCard("DSCR mínimo", "r_dscr_min"));
  kpiGrid2.appendChild(kpiCard("Buffer requerido (USD)", "r_buffer"));
  kpiGrid2.appendChild(kpiCard("FCFE acumulado final", "r_fcfe_sum"));

  const alerts = el("div", { id: "alertsBox", style: { marginTop: "12px" } });

  const exportRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginTop: "12px" } }, [
    el("button", { id: "btnExportCSVTable", type: "button" }, ["Export CSV (tabla mensual)"]),
    el("button", { id: "btnExportCSVKPIs", type: "button" }, ["Export CSV (KPIs)"]),
  ]);

  const tableHost = el("div", { style: { marginTop: "12px" } }, [
    el("div", { style: { fontWeight: "800", marginBottom: "8px" } }, ["Tabla mensual"]),
    el("div", { id: "table", style: { maxHeight: "520px", overflow: "auto", border: "1px solid #ddd", borderRadius: "10px" } })
  ]);

  host.appendChild(kpiGrid);
  host.appendChild(kpiGrid2);
  host.appendChild(alerts);
  host.appendChild(exportRow);
  host.appendChild(tableHost);
}

function buildCompareView(host) {
  if (!host) return;
  host.innerHTML = "";

  // A vs B
  const abBox = section("Comparación A vs B", [
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [
      el("span", { style: { fontWeight: "800" } }, ["A:"]),
      el("select", { id: "cmpA", style: { width: "240px" } }),
      el("span", { style: { fontWeight: "800" } }, ["B:"]),
      el("select", { id: "cmpB", style: { width: "240px" } }),
      el("button", { id: "btnCompareAB", type: "button" }, ["Comparar"]),
    ]),
    el("div", { id: "cmpABKPIs", style: { marginTop: "12px" } }),
  ]);

  // Base vs Multi
  const multiBox = section("Base vs múltiples escenarios (delta KPIs)", [
    el("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" } }, [
      el("span", { style: { fontWeight: "800" } }, ["Base:"]),
      el("select", { id: "cmpBase", style: { minWidth: "260px" } }),
      el("button", { id: "btnPickAll", type: "button" }, ["Seleccionar todos"]),
      el("button", { id: "btnPickNone", type: "button" }, ["Ninguno"]),
      el("button", { id: "btnRunCompareMulti", type: "button" }, ["Comparar"]),
    ]),
    el("div", { style: { marginTop: "8px" } }, [
      el("div", { style: { fontWeight: "700", marginBottom: "6px" } }, ["Escenarios a comparar (Ctrl/Shift)"]),
      el("select", { id: "cmpMulti", multiple: true, size: 10, style: { width: "100%", minHeight: "210px" } })
    ]),
    el("div", { id: "cmpMultiOut", style: { marginTop: "12px" } })
  ]);

  // Sensibilidad tornado (simple)
  const sensBox = section("Sensibilidad (tornado simple sobre VAN)", [
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [
      el("span", { style: { fontWeight: "800" } }, ["Escenario:"]),
      el("select", { id: "sensScenario", style: { width: "280px" } }),
      el("span", { style: { fontWeight: "800" } }, ["±%:"]),
      el("input", { id: "sensPct", type: "number", step: "1", value: "10", style: { width: "90px" } }),
      el("button", { id: "btnRunSens", type: "button" }, ["Correr tornado"]),
    ]),
    el("div", { style: { fontSize: "12px", opacity: "0.85", marginTop: "6px" } }, [
      "Parámetros: precio, volumen, capex, costos fijos, variable unitario, WACC (rf/mrp/beta/spread), deuda (si está)."
    ]),
    el("div", { id: "sensOut", style: { marginTop: "12px" } })
  ]);

  host.appendChild(abBox);
  host.appendChild(multiBox);
  host.appendChild(sensBox);
}

function buildJSONView(host) {
  const txt = el("textarea", {
    id: "jsonArea",
    style: { width: "100%", height: "260px", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px" }
  });
  const file = el("input", { id: "jsonFile", type: "file", accept: ".json" });
  const btnExport = el("button", { id: "btnExportJSON", type: "button" }, ["Generar JSON desde Inputs"]);
  const btnImport = el("button", { id: "btnImportJSON", type: "button" }, ["Cargar JSON (pegar)"]);
  const btnDownload = el("button", { id: "btnDownloadJSON", type: "button" }, ["Descargar JSON"]);
  const btnLoadFile = el("button", { id: "btnLoadFileJSON", type: "button" }, ["Cargar archivo JSON"]);

  host.appendChild(section("JSON del proyecto", [
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" } }, [
      btnExport, btnImport, btnDownload,
      el("span", { style: { marginLeft: "10px" } }, ["Archivo:"]),
      file, btnLoadFile
    ]),
    txt,
    el("div", { style: { fontSize: "12px", opacity: "0.85", marginTop: "8px" } }, [
      "Tip: JSON compatible para guardar/cargar estado offline."
    ])
  ]));
}

/* --------------------------
   8) UI <-> State
---------------------------*/
function readNum(id, def = 0) {
  const e = byId(id);
  if (!e) return def;
  const v = Number(e.value);
  return isFiniteNum(v) ? v : def;
}
function readStr(id, def = "") {
  const e = byId(id);
  if (!e) return def;
  const s = String(e.value ?? "").trim();
  return s.length ? s : def;
}
function readBool(id, def = false) {
  const e = byId(id);
  if (!e) return def;
  if (e.type === "checkbox") return !!e.checked;
  return def;
}
function writeVal(id, v) {
  const e = byId(id);
  if (!e) return;
  if (e.type === "checkbox") e.checked = !!v;
  else e.value = String(v);
}

/* --- CapEx table helpers --- */
function capexRowsFromUI() {
  const tbody = byId("capexTbody");
  if (!tbody) return deepClone(DEFAULT_STATE.capex);

  const rows = [];
  for (const tr of Array.from(tbody.querySelectorAll("tr"))) {
    const mi = tr.querySelector('input[data-k="month_index"]');
    const it = tr.querySelector('input[data-k="item"]');
    const am = tr.querySelector('input[data-k="amount"]');
    const r = {
      month_index: Math.trunc(Number(mi?.value ?? 0)),
      item: String(it?.value ?? "CapEx"),
      amount: Number(am?.value ?? 0),
    };
    rows.push({
      month_index: isFiniteNum(r.month_index) ? r.month_index : 0,
      item: r.item,
      amount: isFiniteNum(r.amount) ? r.amount : 0,
    });
  }
  if (rows.length === 0) return deepClone(DEFAULT_STATE.capex);
  return rows;
}
function renderCapexTable(capex) {
  const host = byId("capexTableHost");
  if (!host) return;

  host.innerHTML = "";
  const table = el("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } });
  const thead = el("thead");
  const trh = el("tr");
  const headers = ["month_index", "item", "amount", ""];
  for (const h of headers) {
    trh.appendChild(el("th", { style: { padding: "8px", borderBottom: "1px solid #ddd", textAlign: "left" } }, [h]));
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el("tbody", { id: "capexTbody" });
  for (const r of (capex || [])) {
    tbody.appendChild(capexRowTR(r));
  }
  table.appendChild(tbody);
  host.appendChild(table);
}
function capexRowTR(r) {
  const tr = el("tr");
  const tdMI = el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [
    el("input", { type: "number", step: "1", value: String(r.month_index ?? 0), "data-k": "month_index", style: { width: "110px" } })
  ]);
  const tdItem = el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [
    el("input", { type: "text", value: String(r.item ?? "CapEx"), "data-k": "item", style: { width: "100%" } })
  ]);
  const tdAmt = el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [
    el("input", { type: "number", step: "1", value: String(r.amount ?? 0), "data-k": "amount", style: { width: "140px" } })
  ]);
  const tdDel = el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [
    el("button", { type: "button", onclick: () => tr.remove() }, ["Eliminar"])
  ]);

  tr.appendChild(tdMI);
  tr.appendChild(tdItem);
  tr.appendChild(tdAmt);
  tr.appendChild(tdDel);
  return tr;
}

function readStateFromUI() {
  const S = deepClone(DEFAULT_STATE);

  S.project.name = readStr("project_name", S.project.name);
  S.project.start_yyyymm = readStr("start_yyyymm", S.project.start_yyyymm);
  S.project.horizon_months = Math.trunc(readNum("horizon_months", S.project.horizon_months));
  S.project.tax_rate = readNum("tax_rate", S.project.tax_rate);

  S.rev.volume_0 = readNum("volume_0", S.rev.volume_0);
  S.rev.volume_growth_m = readNum("volume_growth_m", S.rev.volume_growth_m);
  S.rev.capacity_max = readNum("capacity_max", S.rev.capacity_max);
  S.rev.collection_factor = readNum("collection_factor", S.rev.collection_factor);
  S.rev.price_0 = readNum("price_0", S.rev.price_0);
  S.rev.price_growth_m = readNum("price_growth_m", S.rev.price_growth_m);

  S.cost.fixed_0 = readNum("fixed_0", S.cost.fixed_0);
  S.cost.fixed_growth_m = readNum("fixed_growth_m", S.cost.fixed_growth_m);
  S.cost.var_unit_0 = readNum("var_unit_0", S.cost.var_unit_0);
  S.cost.var_unit_growth_m = readNum("var_unit_growth_m", S.cost.var_unit_growth_m);
  S.cost.maintenance_0 = readNum("maintenance_0", S.cost.maintenance_0);
  S.cost.maintenance_growth_m = readNum("maintenance_growth_m", S.cost.maintenance_growth_m);

  S.wc.enabled = readBool("wc_enabled", S.wc.enabled);
  S.wc.dso = Math.trunc(readNum("dso", S.wc.dso));
  S.wc.dpo = Math.trunc(readNum("dpo", S.wc.dpo));
  S.wc.dio = Math.trunc(readNum("dio", S.wc.dio));
  S.wc.ap_fixed_share = readNum("ap_fixed_share", S.wc.ap_fixed_share);

  S.wacc.e_pct = readNum("e_pct", S.wacc.e_pct);
  S.wacc.d_pct = readNum("d_pct", S.wacc.d_pct);
  S.wacc.rf = readNum("rf", S.wacc.rf);
  S.wacc.mrp = readNum("mrp", S.wacc.mrp);
  S.wacc.beta = readNum("beta", S.wacc.beta);
  S.wacc.spread = readNum("spread", S.wacc.spread);
  S.wacc.tax_rate = readNum("wacc_tax_rate", S.wacc.tax_rate);

  S.capex = capexRowsFromUI();

  S.fin.enabled = readBool("fin_enabled", S.fin.enabled);
  S.fin.debt_amount_0 = readNum("debt_amount_0", S.fin.debt_amount_0);
  S.fin.interest_rate_annual = readNum("interest_rate_annual", S.fin.interest_rate_annual);
  S.fin.term_months = Math.trunc(readNum("term_months", S.fin.term_months));
  S.fin.grace_months = Math.trunc(readNum("grace_months", S.fin.grace_months));
  S.fin.amortization_type = readStr("amortization_type", S.fin.amortization_type);
  S.fin.tax_shield_enabled = readBool("tax_shield_enabled", S.fin.tax_shield_enabled);

  return S;
}

function writeStateToUI(S) {
  writeVal("project_name", S.project?.name ?? "");
  writeVal("start_yyyymm", S.project?.start_yyyymm ?? "");
  writeVal("horizon_months", S.project?.horizon_months ?? 60);
  writeVal("tax_rate", S.project?.tax_rate ?? 0);

  writeVal("volume_0", S.rev?.volume_0 ?? 0);
  writeVal("volume_growth_m", S.rev?.volume_growth_m ?? 0);
  writeVal("capacity_max", S.rev?.capacity_max ?? 0);
  writeVal("collection_factor", S.rev?.collection_factor ?? 0);
  writeVal("price_0", S.rev?.price_0 ?? 0);
  writeVal("price_growth_m", S.rev?.price_growth_m ?? 0);

  writeVal("fixed_0", S.cost?.fixed_0 ?? 0);
  writeVal("fixed_growth_m", S.cost?.fixed_growth_m ?? 0);
  writeVal("var_unit_0", S.cost?.var_unit_0 ?? 0);
  writeVal("var_unit_growth_m", S.cost?.var_unit_growth_m ?? 0);
  writeVal("maintenance_0", S.cost?.maintenance_0 ?? 0);
  writeVal("maintenance_growth_m", S.cost?.maintenance_growth_m ?? 0);

  writeVal("wc_enabled", !!S.wc?.enabled);
  writeVal("dso", S.wc?.dso ?? 0);
  writeVal("dpo", S.wc?.dpo ?? 0);
  writeVal("dio", S.wc?.dio ?? 0);
  writeVal("ap_fixed_share", S.wc?.ap_fixed_share ?? 0);

  writeVal("e_pct", S.wacc?.e_pct ?? 0);
  writeVal("d_pct", S.wacc?.d_pct ?? 0);
  writeVal("rf", S.wacc?.rf ?? 0);
  writeVal("mrp", S.wacc?.mrp ?? 0);
  writeVal("beta", S.wacc?.beta ?? 0);
  writeVal("spread", S.wacc?.spread ?? 0);
  writeVal("wacc_tax_rate", S.wacc?.tax_rate ?? 0);

  renderCapexTable(Array.isArray(S.capex) ? S.capex : deepClone(DEFAULT_STATE.capex));

  writeVal("fin_enabled", !!S.fin?.enabled);
  writeVal("debt_amount_0", S.fin?.debt_amount_0 ?? 0);
  writeVal("interest_rate_annual", S.fin?.interest_rate_annual ?? 0);
  writeVal("term_months", S.fin?.term_months ?? 60);
  writeVal("grace_months", S.fin?.grace_months ?? 0);
  writeVal("amortization_type", S.fin?.amortization_type ?? "french");
  writeVal("tax_shield_enabled", !!S.fin?.tax_shield_enabled);
}

/* --------------------------
   9) Validación (relajada para permitir ceros)
---------------------------*/
function validateInputs(S) {
  const errors = [];
  const warns = [];

  if (!Number.isInteger(S.project.horizon_months) || S.project.horizon_months < 12) {
    warns.push("Horizonte < 12 meses o inválido: resultados pueden ser poco representativos.");
  }
  if (!(S.project.tax_rate >= 0 && S.project.tax_rate <= 0.6)) errors.push("Impuesto fuera de rango (0..0.6).");

  // Permitimos capacity_max = 0 (estado cero)
  if (!(S.rev.capacity_max >= 0)) errors.push("Capacidad máxima debe ser >= 0.");
  if (!(S.rev.collection_factor >= 0 && S.rev.collection_factor <= 1)) errors.push("Factor cobranza debe estar entre 0 y 1.");

  if (S.wc.enabled) {
    if (S.wc.dso < 0 || S.wc.dpo < 0 || S.wc.dio < 0) errors.push("DSO/DPO/DIO no pueden ser negativos.");
    if (!(S.wc.ap_fixed_share >= 0 && S.wc.ap_fixed_share <= 1)) errors.push("% fijos elegibles en AP debe estar 0..1.");
  }

  if (Math.abs((S.wacc.e_pct + S.wacc.d_pct) - 1.0) > 1e-6) warns.push("E% + D% no suma 100% (se usa tal cual).");
  if (S.wacc.tax_rate < 0 || S.wacc.tax_rate > 0.6) warns.push("Tasa impuesto WACC fuera de rango típico (0..0.6).");

  // CapEx: month_index >=0
  if (Array.isArray(S.capex)) {
    for (const r of S.capex) {
      if (!Number.isInteger(r.month_index) || r.month_index < 0) errors.push("CapEx: month_index debe ser entero >= 0.");
    }
  }

  if (S.fin.enabled) {
    if (S.fin.debt_amount_0 < 0) errors.push("Deuda inicial no puede ser negativa.");
    if (S.fin.interest_rate_annual < 0) errors.push("Tasa deuda no puede ser negativa.");
    if (S.fin.term_months < 1) errors.push("Plazo deuda debe ser >= 1.");
    if (S.fin.grace_months < 0 || S.fin.grace_months > S.fin.term_months) errors.push("Gracia inválida.");
    if (!["french", "german"].includes(S.fin.amortization_type)) errors.push("Sistema debe ser french/german.");
  }

  return { errors, warns };
}

function renderMessages(errors, warns) {
  const box = byId("msgBox");
  box.innerHTML = "";

  if (errors.length) {
    box.appendChild(el("div", {
      style: { border: "1px solid #d00", padding: "10px", borderRadius: "10px", background: "#fff5f5", whiteSpace: "pre-wrap" }
    }, ["Errores (bloqueantes):\n- " + errors.join("\n- ")]));
  }
  if (warns.length) {
    box.appendChild(el("div", {
      style: { border: "1px solid #999", padding: "10px", borderRadius: "10px", background: "#f7f7ff", marginTop: "8px", whiteSpace: "pre-wrap" }
    }, ["Advertencias:\n- " + warns.join("\n- ")]));
  }
}

/* --------------------------
   10) Resultados render
---------------------------*/
function setText(id, text) {
  const n = byId(id);
  if (n) n.textContent = text;
}

function renderWaccCaption(S) {
  try {
    const cap = byId("waccCaption");
    if (!cap || !window.FinanceEngine) return;
    const { ke, waccA, waccM } = window.FinanceEngine.computeWacc(S.wacc);
    cap.textContent = `Ke anual: ${fmtPct(ke)} | WACC anual: ${fmtPct(waccA)} | WACC mensual: ${fmtPct(waccM)}`;
  } catch (_) {}
}

function renderKPIs(res) {
  setText("r_van", fmtMoney(res.van));
  setText("r_tir_m", res.tir_m === null ? "N/D" : fmtPct(res.tir_m));
  setText("r_tir_a", res.tir_a === null ? "N/D" : fmtPct(res.tir_a));
  setText("r_wacc_a", fmtPct(res.wacc_a));
  setText("r_wacc_m", fmtPct(res.wacc_m));
  setText("r_pb", res.payback === null ? "N/D" : String(res.payback));
  setText("r_dpb", res.discounted_payback === null ? "N/D" : String(res.discounted_payback));

  setText("r_irr_e_a", res.irr_e_a === null ? "N/D" : fmtPct(res.irr_e_a));
  setText("r_dscr_min", res.dscr_min === null || !isFiniteNum(res.dscr_min) ? "N/D" : res.dscr_min.toFixed(2));
  setText("r_buffer", fmtMoney(res.buffer_required));

  const fcfeSum = Array.isArray(res.fcfe) ? res.fcfe.reduce((a, b) => a + b, 0) : NaN;
  setText("r_fcfe_sum", fmtMoney(fcfeSum));

  const alertsBox = byId("alertsBox");
  alertsBox.innerHTML = "";
  const alerts = [];

  if (res.dscr_min !== null && isFiniteNum(res.dscr_min)) {
    if (res.dscr_min < 1.0) alerts.push("🔴 DSCR < 1: no cubre servicio de deuda en al menos un mes.");
    else if (res.dscr_min < 1.2) alerts.push("🟠 DSCR < 1.2: cobertura ajustada.");
  }
  if (isFiniteNum(res.buffer_required) && res.buffer_required > 0) alerts.push(`🔵 Buffer requerido (equity): ${fmtMoney(res.buffer_required)} USD.`);

  if (alerts.length) {
    alertsBox.appendChild(el("div", {
      style: { border: "1px solid #999", padding: "10px", borderRadius: "10px", background: "#f7f7ff", whiteSpace: "pre-wrap" }
    }, [alerts.join("\n")]));
  }
}

function renderTable(df) {
  const host = byId("table");
  host.innerHTML = "";

  if (!Array.isArray(df) || df.length === 0) {
    host.appendChild(el("div", { style: { padding: "12px" } }, ["Sin datos."]));
    return;
  }

  const cols = Object.keys(df[0]);
  const table = el("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } });

  const thead = el("thead");
  const trh = el("tr");
  for (const c of cols) {
    trh.appendChild(el("th", { style: { borderBottom: "1px solid #ddd", padding: "8px", position: "sticky", top: "0", background: "#fff", textAlign: "left" } }, [c]));
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of df) {
    const tr = el("tr");
    for (const c of cols) {
      const v = row[c];
      let txt = "";
      if (typeof v === "number" && isFiniteNum(v)) txt = v.toFixed(2);
      else txt = String(v ?? "");
      tr.appendChild(el("td", { style: { borderBottom: "1px solid #f0f0f0", padding: "6px 8px" } }, [txt]));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  host.appendChild(table);
}

/* --------------------------
   11) Cálculo principal
---------------------------*/
function calcFromState(S) {
  if (!window.FinanceEngine || !window.FinanceEngine.buildCashflowTable) {
    throw new Error("No se cargó engine.js (FinanceEngine). Revisá el orden de scripts en index.html.");
  }
  return window.FinanceEngine.buildCashflowTable(S);
}

function doCalc() {
  let S = readStateFromUI();
  renderWaccCaption(S);

  const { errors, warns } = validateInputs(S);
  renderMessages(errors, warns);
  if (errors.length) return null;

  const res = calcFromState(S);

  renderKPIs(res);
  renderTable(res.df);

  // JSON view live
  const payload = { ...deepClone(S), meta: { exported_at: new Date().toISOString() } };
  const area = byId("jsonArea");
  if (area) area.value = JSON.stringify(payload, null, 2);

  saveLastState(S);

  // Ir a Resultados
  byId("tabResults").click();
  return { S, res };
}

/* --------------------------
   12) Reset (a cero)
---------------------------*/
function newScenario() {
  writeStateToUI(deepClone(DEFAULT_STATE));
  byId("scName").value = "";
  renderWaccCaption(readStateFromUI());
  renderMessages([], []);
  saveLastState(readStateFromUI());
}

/* --------------------------
   13) Escenarios CRUD + LOCK
---------------------------*/
function refreshScenarioList(selected = "") {
  const list = byId("scList");
  if (!list) return;

  const names = getIndex().slice().sort((a, b) => a.localeCompare(b));
  list.innerHTML = "";

  if (names.length === 0) {
    list.appendChild(el("option", { value: "" }, ["(sin escenarios)"]));
    return;
  }
  for (const n of names) {
    const lock = isScenarioLocked(n) ? " 🔒" : "";
    const opt = el("option", { value: n }, [n + lock]);
    if (n === selected) opt.selected = true;
    list.appendChild(opt);
  }
}

function updateLockBadge(name) {
  const b = byId("scLockBadge");
  if (!b) return;
  if (!name) { b.textContent = ""; return; }
  b.textContent = isScenarioLocked(name) ? "Bloqueado (🔒)" : "Editable";
}

function saveScenario() {
  const name = safeName(byId("scName").value);
  if (!name) { alert("Poné un nombre de escenario."); byId("scName").focus(); return; }

  // si existe y está locked, no dejamos sobrescribir
  if (getScenarioPayloadByName(name) && isScenarioLocked(name)) {
    alert(`El escenario "${name}" está bloqueado. Desbloquealo para sobrescribir.`);
    return;
  }

  const S = readStateFromUI();
  const payload = {
    S,
    meta: {
      savedAt: new Date().toISOString(),
      locked: false
    }
  };

  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(payload));

  const idx = new Set(getIndex());
  idx.add(name);
  setIndex([...idx]);

  refreshScenarioList(name);
  updateLockBadge(name);
  refreshCompareUI();
}

function parseOptionTextToName(optText) {
  return String(optText || "").replace(" 🔒", "").trim();
}

function loadScenario() {
  const list = byId("scList");
  if (!list || list.selectedIndex < 0) return;

  const name = parseOptionTextToName(list.options[list.selectedIndex].textContent);
  if (!name) return;

  const p = getScenarioPayloadByName(name);
  if (!p || !p.S) { alert("No se encontró el escenario."); return; }

  writeStateToUI(p.S);
  byId("scName").value = name;

  updateLockBadge(name);
  renderWaccCaption(p.S);
  doCalc();
}

function deleteScenario() {
  const list = byId("scList");
  if (!list || list.selectedIndex < 0) return;

  const name = parseOptionTextToName(list.options[list.selectedIndex].textContent);
  if (!name) return;

  if (isScenarioLocked(name)) {
    alert(`El escenario "${name}" está bloqueado. Desbloquealo para eliminar.`);
    return;
  }
  if (!confirm(`Eliminar escenario "${name}"?`)) return;

  localStorage.removeItem(DATA_PREFIX + name);
  setIndex(getIndex().filter(n => n !== name));
  refreshScenarioList("");
  updateLockBadge("");
  refreshCompareUI();
}

function toggleLockScenario() {
  const name = safeName(byId("scName").value) || (() => {
    const list = byId("scList");
    if (!list || list.selectedIndex < 0) return "";
    return parseOptionTextToName(list.options[list.selectedIndex].textContent);
  })();

  if (!name) { alert("Elegí o escribí un escenario para lock/unlock."); return; }

  const p = getScenarioPayloadByName(name);
  if (!p) { alert("Ese escenario no existe todavía. Guardalo primero."); return; }

  const locked = isScenarioLocked(name);
  setScenarioLock(name, !locked);

  refreshScenarioList(name);
  updateLockBadge(name);
  refreshCompareUI();
}

/* --------------------------
   14) JSON Import/Export
---------------------------*/
function exportJSONToArea() {
  const S = readStateFromUI();
  const payload = { ...deepClone(S), meta: { exported_at: new Date().toISOString() } };
  byId("jsonArea").value = JSON.stringify(payload, null, 2);
}
function importJSONFromArea() {
  const txt = byId("jsonArea").value || "";
  let payload;
  try { payload = JSON.parse(txt); } catch { alert("JSON inválido."); return; }

  const S = payload.S ? payload.S : payload;
  if (!S.project || !S.rev || !S.cost || !S.wc || !S.wacc || !S.capex || !S.fin) {
    alert("JSON no tiene la estructura esperada (project/rev/cost/wc/wacc/capex/fin).");
    return;
  }

  writeStateToUI(S);
  renderWaccCaption(S);
  doCalc();
}
function downloadJSON() {
  exportJSONToArea();
  const data = byId("jsonArea").value;
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName(readStr("project_name", "proyecto")) || "proyecto"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function loadJSONFile() {
  const inp = byId("jsonFile");
  if (!inp.files || !inp.files[0]) { alert("Elegí un archivo JSON."); return; }
  const file = inp.files[0];
  const reader = new FileReader();
  reader.onload = () => {
    byId("jsonArea").value = String(reader.result || "");
    importJSONFromArea();
  };
  reader.readAsText(file, "utf-8");
}

/* --------------------------
   15) Export CSV
---------------------------*/
function toCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  const lines = [];
  lines.push(cols.map(esc).join(","));
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(","));
  return lines.join("\n");
}
function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

let LAST_RES = null; // cache para export
function exportCSVTable() {
  if (!LAST_RES || !Array.isArray(LAST_RES.df)) { alert("Primero calculá."); return; }
  const csv = toCSV(LAST_RES.df);
  downloadText("flujo_mensual.csv", csv, "text/csv");
}
function exportCSVKPIs() {
  if (!LAST_RES) { alert("Primero calculá."); return; }
  const rows = [{
    VAN_USD: LAST_RES.van,
    TIR_mensual: LAST_RES.tir_m,
    TIR_anual_eq: LAST_RES.tir_a,
    WACC_anual: LAST_RES.wacc_a,
    WACC_mensual: LAST_RES.wacc_m,
    Payback_mes: LAST_RES.payback,
    Payback_desc_mes: LAST_RES.discounted_payback,
    TIR_equity_anual_eq: LAST_RES.irr_e_a,
    DSCR_min: LAST_RES.dscr_min,
    Buffer_USD: LAST_RES.buffer_required,
  }];
  const csv = toCSV(rows);
  downloadText("kpis.csv", csv, "text/csv");
}

/* --------------------------
   16) Comparación (A vs B) + (Base vs Multi)
---------------------------*/
function fillCompareSelectors() {
  const names = getIndex().slice().sort((a, b) => a.localeCompare(b));

  const selA = byId("cmpA");
  const selB = byId("cmpB");
  const selBase = byId("cmpBase");
  const selMulti = byId("cmpMulti");
  const selSens = byId("sensScenario");

  const fill = (sel, withEmpty = true) => {
    if (!sel) return;
    sel.innerHTML = "";
    if (withEmpty) sel.appendChild(el("option", { value: "" }, ["(elegir)"]));
    for (const n of names) sel.appendChild(el("option", { value: n }, [n]));
  };

  fill(selA, true);
  fill(selB, true);
  fill(selBase, true);
  fill(selSens, true);

  if (selMulti) {
    selMulti.innerHTML = "";
    for (const n of names) selMulti.appendChild(el("option", { value: n }, [n]));
  }
}

function refreshCompareUI() {
  fillCompareSelectors();
}

function renderCompareKpiTable(baseName, baseRes, items) {
  // items: [{name,res}]
  const host = byId("cmpMultiOut");
  if (!host) return;
  host.innerHTML = "";

  const cols = [
    { k: "van", label: "VAN" },
    { k: "tir_a", label: "TIR anual" },
    { k: "dscr_min", label: "DSCR min" },
    { k: "buffer_required", label: "Buffer" },
  ];

  const table = el("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } });
  const thead = el("thead");
  const trh = el("tr");
  trh.appendChild(el("th", { style: { padding: "8px", borderBottom: "1px solid #ddd", textAlign: "left" } }, ["Escenario"]));
  for (const c of cols) {
    trh.appendChild(el("th", { style: { padding: "8px", borderBottom: "1px solid #ddd", textAlign: "left" } }, [c.label + " (Δ vs base)"]));
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const it of items) {
    const tr = el("tr");
    tr.appendChild(el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [it.name]));
    for (const c of cols) {
      const b = baseRes[c.k];
      const v = it.res[c.k];
      const d = (isFiniteNum(v) && isFiniteNum(b)) ? (v - b) : NaN;

      let txt = "N/D";
      if (c.k === "tir_a") txt = isFiniteNum(d) ? fmtPct(d) : "N/D";
      else if (c.k === "dscr_min") txt = isFiniteNum(d) ? d.toFixed(2) : "N/D";
      else txt = isFiniteNum(d) ? fmtMoney(d) : "N/D";

      tr.appendChild(el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [txt]));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  host.appendChild(el("div", { style: { fontWeight: "800", marginBottom: "8px" } }, [
    `Base: ${baseName}`
  ]));
  host.appendChild(table);
}

function compareAB() {
  const a = byId("cmpA")?.value || "";
  const b = byId("cmpB")?.value || "";
  const host = byId("cmpABKPIs");
  if (!host) return;
  host.innerHTML = "";

  if (!a || !b) { host.appendChild(el("div", {}, ["Elegí A y B."])); return; }
  if (a === b) { host.appendChild(el("div", {}, ["A y B son el mismo escenario."])); return; }

  const SA = getScenarioStateByName(a);
  const SB = getScenarioStateByName(b);
  if (!SA || !SB) { host.appendChild(el("div", {}, ["No se pudieron cargar los escenarios."])); return; }

  let rA, rB;
  try { rA = calcFromState(SA); rB = calcFromState(SB); }
  catch (e) { host.appendChild(el("div", {}, ["Error calculando: " + e.message])); return; }

  const rows = [
    { KPI: "VAN (USD)", A: fmtMoney(rA.van), B: fmtMoney(rB.van), "Δ (B-A)": fmtMoney(rB.van - rA.van) },
    { KPI: "TIR anual eq.", A: rA.tir_a === null ? "N/D" : fmtPct(rA.tir_a), B: rB.tir_a === null ? "N/D" : fmtPct(rB.tir_a), "Δ (B-A)": (rA.tir_a === null || rB.tir_a === null) ? "N/D" : fmtPct(rB.tir_a - rA.tir_a) },
    { KPI: "DSCR min", A: rA.dscr_min === null ? "N/D" : rA.dscr_min.toFixed(2), B: rB.dscr_min === null ? "N/D" : rB.dscr_min.toFixed(2), "Δ (B-A)": (rA.dscr_min === null || rB.dscr_min === null) ? "N/D" : (rB.dscr_min - rA.dscr_min).toFixed(2) },
    { KPI: "Buffer (USD)", A: fmtMoney(rA.buffer_required), B: fmtMoney(rB.buffer_required), "Δ (B-A)": fmtMoney(rB.buffer_required - rA.buffer_required) },
  ];

  host.appendChild(el("div", { style: { fontWeight: "800", marginBottom: "8px" } }, [`A: ${a}  |  B: ${b}`]));
  host.appendChild(el("div", { style: { border: "1px solid #ddd", borderRadius: "10px", overflow: "auto" } }, [
    el("div", { style: { padding: "10px" } }, [
      el("pre", { style: { margin: 0, whiteSpace: "pre-wrap", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px" } },
        [rows.map(r => `${r.KPI}:  A=${r.A} | B=${r.B} | Δ=${r["Δ (B-A)"]}`).join("\n")]
      )
    ])
  ]));
}

function pickAllCompare() {
  const m = byId("cmpMulti");
  if (!m) return;
  for (const o of Array.from(m.options)) o.selected = true;
}
function pickNoneCompare() {
  const m = byId("cmpMulti");
  if (!m) return;
  for (const o of Array.from(m.options)) o.selected = false;
}

function runCompareMulti() {
  const baseName = byId("cmpBase")?.value || "";
  const multi = byId("cmpMulti");
  if (!baseName || !multi) { alert("Elegí base y al menos un escenario."); return; }

  const selected = Array.from(multi.selectedOptions).map(o => o.value).filter(Boolean).filter(n => n !== baseName);
  if (selected.length === 0) { alert("Seleccioná escenarios distintos al base."); return; }

  const SBase = getScenarioStateByName(baseName);
  if (!SBase) { alert("No se pudo cargar el base."); return; }

  let rBase;
  try { rBase = calcFromState(SBase); } catch (e) { alert("Error calculando base: " + e.message); return; }

  const items = [];
  for (const n of selected) {
    const Sx = getScenarioStateByName(n);
    if (!Sx) continue;
    try {
      const rx = calcFromState(Sx);
      items.push({ name: n, res: rx });
    } catch (_) {}
  }

  renderCompareKpiTable(baseName, rBase, items);
}

/* --------------------------
   17) Sensibilidad (tornado simple sobre VAN)
---------------------------*/
function runSensitivity() {
  const name = byId("sensScenario")?.value || "";
  const pct = Number(byId("sensPct")?.value ?? 10);
  const host = byId("sensOut");
  if (!host) return;
  host.innerHTML = "";

  if (!name) { host.appendChild(el("div", {}, ["Elegí un escenario."])); return; }
  if (!isFiniteNum(pct) || pct <= 0) { host.appendChild(el("div", {}, ["±% inválido."])); return; }

  const S0 = getScenarioStateByName(name);
  if (!S0) { host.appendChild(el("div", {}, ["No se pudo cargar el escenario."])); return; }

  let baseRes;
  try { baseRes = calcFromState(S0); } catch (e) { host.appendChild(el("div", {}, ["Error: " + e.message])); return; }

  const p = pct / 100;

  const tests = [
    { label: "Precio inicial (price_0)", apply: (S, f) => (S.rev.price_0 *= f) },
    { label: "Volumen inicial (volume_0)", apply: (S, f) => (S.rev.volume_0 *= f) },
    { label: "CapEx total (amount)", apply: (S, f) => (S.capex.forEach(r => r.amount *= f)) },
    { label: "Costos fijos (fixed_0)", apply: (S, f) => (S.cost.fixed_0 *= f) },
    { label: "Variable unitario (var_unit_0)", apply: (S, f) => (S.cost.var_unit_0 *= f) },
    { label: "WACC: rf", apply: (S, f) => (S.wacc.rf *= f) },
    { label: "WACC: mrp", apply: (S, f) => (S.wacc.mrp *= f) },
    { label: "WACC: beta", apply: (S, f) => (S.wacc.beta *= f) },
    { label: "WACC: spread", apply: (S, f) => (S.wacc.spread *= f) },
  ];

  if (S0.fin?.enabled) {
    tests.push({ label: "Deuda: tasa anual", apply: (S, f) => (S.fin.interest_rate_annual *= f) });
    tests.push({ label: "Deuda: D0", apply: (S, f) => (S.fin.debt_amount_0 *= f) });
  }

  const baseVAN = baseRes.van;

  const out = [];
  for (const t of tests) {
    const Splus = deepClone(S0);
    const Sminus = deepClone(S0);

    t.apply(Splus, 1 + p);
    t.apply(Sminus, 1 - p);

    let vanPlus = NaN, vanMinus = NaN;
    try { vanPlus = calcFromState(Splus).van; } catch {}
    try { vanMinus = calcFromState(Sminus).van; } catch {}

    const dPlus = isFiniteNum(vanPlus) && isFiniteNum(baseVAN) ? (vanPlus - baseVAN) : NaN;
    const dMinus = isFiniteNum(vanMinus) && isFiniteNum(baseVAN) ? (vanMinus - baseVAN) : NaN;

    const impact = Math.max(Math.abs(dPlus), Math.abs(dMinus));
    out.push({ Parametro: t.label, "Δ VAN (+)": dPlus, "Δ VAN (-)": dMinus, "Impacto abs": impact });
  }

  out.sort((a, b) => (b["Impacto abs"] || 0) - (a["Impacto abs"] || 0));

  const rows = out.map(r => ({
    Parametro: r.Parametro,
    "Δ VAN (+)": isFiniteNum(r["Δ VAN (+)"]) ? fmtMoney(r["Δ VAN (+)"]) : "N/D",
    "Δ VAN (-)": isFiniteNum(r["Δ VAN (-)"]) ? fmtMoney(r["Δ VAN (-)"]) : "N/D",
  }));

  host.appendChild(el("div", { style: { fontWeight: "800", marginBottom: "8px" } }, [
    `Tornado VAN — Escenario: ${name} — ±${pct}%`
  ]));

  const csv = toCSV(rows);
  host.appendChild(el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "8px" } }, [
    el("button", { type: "button", onclick: () => downloadText("tornado_van.csv", csv, "text/csv") }, ["Descargar CSV tornado"])
  ]));

  // tabla simple
  const table = el("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } });
  const thead = el("thead");
  const trh = el("tr");
  for (const c of Object.keys(rows[0] || { Parametro: 1, "Δ VAN (+)": 1, "Δ VAN (-)": 1 })) {
    trh.appendChild(el("th", { style: { padding: "8px", borderBottom: "1px solid #ddd", textAlign: "left" } }, [c]));
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of Object.keys(r)) {
      tr.appendChild(el("td", { style: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0" } }, [String(r[c])]));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(el("div", { style: { border: "1px solid #ddd", borderRadius: "10px", overflow: "auto" } }, [table]));
}

/* --------------------------
   18) Wire up
---------------------------*/
function wire() {
  ensureUI();

  // Estado inicial: si hay lastState, lo usamos; si no, todo en cero
  const last = loadLastState();
  const startS = last ? last : deepClone(DEFAULT_STATE);

  writeStateToUI(startS);
  renderWaccCaption(readStateFromUI());
  renderCapexTable(startS.capex);

  refreshScenarioList("");
  refreshCompareUI();
  updateLockBadge("");

  // CapEx buttons
  byId("btnCapexAdd")?.addEventListener("click", () => {
    const tbody = byId("capexTbody");
    if (!tbody) return;
    tbody.appendChild(capexRowTR({ month_index: 0, item: "CapEx", amount: 0 }));
  });
  byId("btnCapexClear")?.addEventListener("click", () => {
    renderCapexTable([{ month_index: 0, item: "Inversión inicial", amount: 0 }]);
  });

  // Calcular / Reset
  byId("btnCalc")?.addEventListener("click", () => {
    try {
      const out = doCalc();
      if (out && out.res) LAST_RES = out.res;
    } catch (e) {
      alert(e.message);
    }
  });
  byId("btnReset")?.addEventListener("click", () => {
    newScenario();
    LAST_RES = null;
  });

  // Escenarios
  byId("btnSaveSc")?.addEventListener("click", () => { saveScenario(); });
  byId("btnLoadSc")?.addEventListener("click", () => { loadScenario(); });
  byId("btnDelSc")?.addEventListener("click", () => { deleteScenario(); });
  byId("btnNewSc")?.addEventListener("click", () => { newScenario(); });
  byId("btnLockSc")?.addEventListener("click", () => { toggleLockScenario(); });

  // Cuando cambia el select de escenarios, actualizamos badge
  byId("scList")?.addEventListener("change", () => {
    const list = byId("scList");
    if (!list || list.selectedIndex < 0) return;
    const name = parseOptionTextToName(list.options[list.selectedIndex].textContent);
    updateLockBadge(name);
  });

  // JSON
  byId("btnExportJSON")?.addEventListener("click", exportJSONToArea);
  byId("btnImportJSON")?.addEventListener("click", importJSONFromArea);
  byId("btnDownloadJSON")?.addEventListener("click", downloadJSON);
  byId("btnLoadFileJSON")?.addEventListener("click", loadJSONFile);

  // Export CSV (Resultados)
  byId("btnExportCSVTable")?.addEventListener("click", exportCSVTable);
  byId("btnExportCSVKPIs")?.addEventListener("click", exportCSVKPIs);

  // Compare
  byId("btnCompareAB")?.addEventListener("click", compareAB);
  byId("btnPickAll")?.addEventListener("click", pickAllCompare);
  byId("btnPickNone")?.addEventListener("click", pickNoneCompare);
  byId("btnRunCompareMulti")?.addEventListener("click", runCompareMulti);

  // Sensibilidad
  byId("btnRunSens")?.addEventListener("click", runSensitivity);

  // WACC caption live
  const waccIds = ["e_pct","d_pct","rf","mrp","beta","spread","wacc_tax_rate"];
  for (const id of waccIds) {
    const e = byId(id);
    if (e) e.addEventListener("input", () => renderWaccCaption(readStateFromUI()));
  }

  // Render inicial: si había lastState, intentamos calcular para poblar resultados
  try {
    const out = doCalc();
    if (out && out.res) LAST_RES = out.res;
  } catch (_) {}
}

window.addEventListener("load", wire);
