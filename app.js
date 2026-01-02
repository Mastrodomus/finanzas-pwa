/* app.js (completo, estable, con:
   - UI completa (Inputs / Resultados / Comparación / JSON)
   - Calcular + Reset (reset deja TODO en 0, pero mantiene estructura)
   - Escenarios: guardar/cargar/eliminar
   - Comparación A vs B (KPIs + delta mensual)
   - Persistencia: último estado + último tab + último resultado (opcional)
   Requiere: <script src="engine.js"></script> antes que app.js
*/

"use strict";

/* --------------------------
   0) SW register (opcional)
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
   1) Estado: defaults (todo en cero)
---------------------------*/
const DEFAULT_STATE = {
  project: { name: "", start_yyyymm: "", horizon_months: 60, tax_rate: 0.30 },
  rev: {
    volume_0: 0,
    volume_growth_m: 0,
    capacity_max: 0,
    collection_factor: 1,
    price_0: 0,
    price_growth_m: 0,
  },
  cost: {
    fixed_0: 0,
    fixed_growth_m: 0,
    var_unit_0: 0,
    var_unit_growth_m: 0,
    maintenance_0: 0,
    maintenance_growth_m: 0,
  },
  wc: { enabled: false, dso: 0, dpo: 0, dio: 0, ap_fixed_share: 0.25 },
  wacc: { e_pct: 0.60, d_pct: 0.40, rf: 0, mrp: 0, beta: 1, spread: 0, tax_rate: 0.30 },
  capex: [{ month_index: 0, item: "Inversión inicial", amount: 0 }],
  fin: {
    enabled: false,
    debt_amount_0: 0,
    interest_rate_annual: 0,
    term_months: 60,
    grace_months: 0,
    amortization_type: "french",
    tax_shield_enabled: false,
  },
};

/* --------------------------
   2) Storage (escenarios + persistencia)
---------------------------*/
const INDEX_KEY = "finanzas.scenarios.index.v3";
const DATA_PREFIX = "finanzas.scenario.v3.";

const LAST_STATE_KEY = "finanzas.lastState.v1";
const LAST_RESULT_KEY = "finanzas.lastResult.v1";
const LAST_TAB_KEY = "finanzas.lastTab.v1";

function getIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) || "[]"); }
  catch { return []; }
}
function setIndex(arr) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(arr));
}
function safeName(s) {
  return String(s || "").trim();
}
function saveLastState(S) {
  try { localStorage.setItem(LAST_STATE_KEY, JSON.stringify(S)); } catch {}
}
function loadLastState() {
  try {
    const raw = localStorage.getItem(LAST_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveLastResult(res) {
  try { localStorage.setItem(LAST_RESULT_KEY, JSON.stringify(res)); } catch {}
}
function loadLastResult() {
  try {
    const raw = localStorage.getItem(LAST_RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveLastTab(tab) {
  try { localStorage.setItem(LAST_TAB_KEY, tab); } catch {}
}
function loadLastTab() {
  try { return localStorage.getItem(LAST_TAB_KEY) || "inputs"; } catch { return "inputs"; }
}

/* --------------------------
   3) Helpers
---------------------------*/
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
function isFiniteNum(x) { return Number.isFinite(x) && !Number.isNaN(x); }

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
  return el("div", { style: { border: "1px solid #ddd", borderRadius: "10px", padding: "12px", marginBottom: "12px" } }, [
    el("div", { style: { fontWeight: "700", marginBottom: "8px" } }, [title]),
    ...children
  ]);
}
function grid(children = []) {
  return el("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" } }, children);
}
function field(label, id, type = "number", step = "any") {
  return el("label", { style: { display: "grid", gap: "6px", fontSize: "13px" } }, [
    el("span", { style: { fontWeight: "600" } }, [label]),
    el("input", { id, type, step })
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
   4) UI base
---------------------------*/
function ensureUI() {
  let root = byId("appRoot");
  if (root) return root;

  root = el("div", {
    id: "appRoot",
    style: { maxWidth: "1100px", margin: "0 auto", padding: "16px", fontFamily: "system-ui, Segoe UI, Arial" }
  });

  const topBar = el("div", {
    style: { display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }
  }, [
    el("div", {}, [
      el("div", { style: { fontSize: "20px", fontWeight: "700" } }, ["Modelo de inversión (offline)"]),
      el("div", { style: { fontSize: "12px", opacity: "0.8" } }, ["FCFF + WACC + (opcional) deuda/FCFE/DSCR/buffer"])
    ]),
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, [
      el("button", { id: "btnCalc", type: "button" }, ["Calcular"]),
      el("button", { id: "btnReset", type: "button" }, ["Reset"]),
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
  }

  byId("tabInputs").addEventListener("click", () => activate("inputs"));
  byId("tabResults").addEventListener("click", () => activate("results"));
  byId("tabCompare").addEventListener("click", () => {
    activate("compare");
    refreshCompareUI();
  });
  byId("tabJSON").addEventListener("click", () => activate("json"));

  activate("inputs");
  return root;
}

/* --------------------------
   5) Views
---------------------------*/
function buildInputsView(host) {
  // Escenarios
  const scName = el("input", { id: "scName", type: "text", placeholder: "Ej: Base enero", style: { width: "220px" } });
  const scList = el("select", { id: "scList", style: { width: "240px" } });

  const scRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [
    el("span", { style: { fontWeight: "700" } }, ["Escenarios"]),
    scName,
    el("button", { id: "btnSaveSc", type: "button" }, ["Guardar"]),
    el("button", { id: "btnNewSc", type: "button" }, ["Nuevo"]),
    el("span", { style: { marginLeft: "8px" } }, ["Cargar:"]),
    scList,
    el("button", { id: "btnLoadSc", type: "button" }, ["Cargar"]),
    el("button", { id: "btnDelSc", type: "button" }, ["Eliminar"]),
  ]);

  // Proyecto
  const secProject = section("1) Proyecto", [
    grid([
      field("Nombre", "project_name", "text"),
      field("Inicio (YYYY-MM)", "start_yyyymm", "text"),
      field("Horizonte (meses)", "horizon_months", "number", "1"),
      field("Impuesto (tasa 0..0.6)", "tax_rate", "number", "0.01"),
    ])
  ]);

  // Ingresos
  const secRev = section("2) Ingresos", [
    grid([
      field("Volumen inicial (mes)", "volume_0", "number", "1"),
      field("Crec. volumen mensual", "volume_growth_m", "number", "0.0001"),
      field("Capacidad máxima (mes)", "capacity_max", "number", "1"),
      field("Factor cobranza (0..1)", "collection_factor", "number", "0.01"),
      field("Precio inicial", "price_0", "number", "0.01"),
      field("Ajuste precio mensual", "price_growth_m", "number", "0.0001"),
    ])
  ]);

  // Costos
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

  // WC
  const secWC = section("4) Capital de trabajo (DSO/DPO/DIO)", [
    el("div", { style: { marginBottom: "8px" } }, [checkbox("Habilitar WC", "wc_enabled")]),
    grid([
      field("DSO", "dso", "number", "1"),
      field("DPO", "dpo", "number", "1"),
      field("DIO", "dio", "number", "1"),
      field("% fijos elegibles en AP (0..1)", "ap_fixed_share", "number", "0.01"),
    ])
  ]);

  // WACC
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

  // CapEx (mes 0)
  const secCapex = section("6) CapEx", [
    grid([ field("CapEx mes 0 (USD)", "capex0_amount", "number", "1") ]),
    el("div", { style: { fontSize: "12px", opacity: "0.85", marginTop: "6px" } }, [
      "Nota: por ahora editás CapEx del mes 0."
    ])
  ]);

  // Deuda
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
      el("div", { id, style: { fontSize: "18px", fontWeight: "800" } }, ["–"]),
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

  const tableHost = el("div", { style: { marginTop: "12px" } }, [
    el("div", { style: { fontWeight: "700", marginBottom: "8px" } }, ["Tabla mensual"]),
    el("div", { id: "table", style: { maxHeight: "520px", overflow: "auto", border: "1px solid #ddd", borderRadius: "10px" } })
  ]);

  host.appendChild(kpiGrid);
  host.appendChild(kpiGrid2);
  host.appendChild(alerts);
  host.appendChild(tableHost);
}

function buildCompareView(host) {
  if (!host) return;
  host.innerHTML = "";

  const compBox = section("Comparación de escenarios (A vs B)", [
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } }, [
      el("span", { style: { fontWeight: "700" } }, ["A:"]),
      el("select", { id: "cmpA", style: { width: "240px" } }),
      el("span", { style: { fontWeight: "700" } }, ["B:"]),
      el("select", { id: "cmpB", style: { width: "240px" } }),
      el("button", { id: "btnCompare", type: "button" }, ["Comparar"]),
    ]),
    el("div", { id: "cmpKPIs", style: { marginTop: "12px" } }),
    el("div", { id: "cmpTable", style: { marginTop: "12px", maxHeight: "420px", overflow: "auto", border: "1px solid #ddd", borderRadius: "10px" } }),
  ]);

  host.appendChild(compBox);
}

function buildJSONView(host) {
  const txt = el("textarea", { id: "jsonArea", style: { width: "100%", height: "260px", fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px" } });
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
      "Tip: este JSON es compatible con export/import (shape equivalente)."
    ])
  ]));
}

/* --------------------------
   6) UI <-> State
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
  else e.value = String(v ?? "");
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

  const cap0 = readNum("capex0_amount", S.capex[0].amount);
  S.capex = [{ month_index: 0, item: "Inversión inicial", amount: cap0 }];

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
  // project
  writeVal("project_name", S.project?.name ?? "");
  writeVal("start_yyyymm", S.project?.start_yyyymm ?? "");
  writeVal("horizon_months", S.project?.horizon_months ?? 60);
  writeVal("tax_rate", S.project?.tax_rate ?? 0.30);

  // rev
  writeVal("volume_0", S.rev?.volume_0 ?? 0);
  writeVal("volume_growth_m", S.rev?.volume_growth_m ?? 0);
  writeVal("capacity_max", S.rev?.capacity_max ?? 0);
  writeVal("collection_factor", S.rev?.collection_factor ?? 1);
  writeVal("price_0", S.rev?.price_0 ?? 0);
  writeVal("price_growth_m", S.rev?.price_growth_m ?? 0);

  // cost
  writeVal("fixed_0", S.cost?.fixed_0 ?? 0);
  writeVal("fixed_growth_m", S.cost?.fixed_growth_m ?? 0);
  writeVal("var_unit_0", S.cost?.var_unit_0 ?? 0);
  writeVal("var_unit_growth_m", S.cost?.var_unit_growth_m ?? 0);
  writeVal("maintenance_0", S.cost?.maintenance_0 ?? 0);
  writeVal("maintenance_growth_m", S.cost?.maintenance_growth_m ?? 0);

  // wc
  writeVal("wc_enabled", !!S.wc?.enabled);
  writeVal("dso", S.wc?.dso ?? 0);
  writeVal("dpo", S.wc?.dpo ?? 0);
  writeVal("dio", S.wc?.dio ?? 0);
  writeVal("ap_fixed_share", S.wc?.ap_fixed_share ?? 0.25);

  // wacc
  writeVal("e_pct", S.wacc?.e_pct ?? 0.60);
  writeVal("d_pct", S.wacc?.d_pct ?? 0.40);
  writeVal("rf", S.wacc?.rf ?? 0);
  writeVal("mrp", S.wacc?.mrp ?? 0);
  writeVal("beta", S.wacc?.beta ?? 1);
  writeVal("spread", S.wacc?.spread ?? 0);
  writeVal("wacc_tax_rate", S.wacc?.tax_rate ?? 0.30);

  // capex0
  const cap0 = (S.capex && S.capex[0]) ? S.capex[0].amount : 0;
  writeVal("capex0_amount", cap0);

  // fin
  writeVal("fin_enabled", !!S.fin?.enabled);
  writeVal("debt_amount_0", S.fin?.debt_amount_0 ?? 0);
  writeVal("interest_rate_annual", S.fin?.interest_rate_annual ?? 0);
  writeVal("term_months", S.fin?.term_months ?? 60);
  writeVal("grace_months", S.fin?.grace_months ?? 0);
  writeVal("amortization_type", S.fin?.amortization_type ?? "french");
  writeVal("tax_shield_enabled", !!S.fin?.tax_shield_enabled);
}

/* --------------------------
   7) Validación robusta
---------------------------*/
function validateInputs(S) {
  const errors = [];
  const warns = [];

  const n = Number(S?.project?.horizon_months ?? 0);
  if (!Number.isFinite(n) || n <= 0) errors.push("Horizonte debe ser > 0.");
  if (n > 240) warns.push("Horizonte > 240 meses: revisá si es intencional.");

  const tax = Number(S?.project?.tax_rate ?? 0);
  if (!Number.isFinite(tax) || tax < 0 || tax > 0.6) errors.push("Impuesto fuera de rango (0..0.6).");

  const capMax = Number(S?.rev?.capacity_max ?? 0);
  if (!Number.isFinite(capMax) || capMax <= 0) errors.push("Capacidad máxima debe ser > 0.");

  const coll = Number(S?.rev?.collection_factor ?? 0);
  if (!Number.isFinite(coll) || coll < 0 || coll > 1) errors.push("Factor de cobranza debe estar entre 0 y 1.");

  const someSignal =
    (Number(S?.rev?.volume_0 ?? 0) !== 0) ||
    (Number(S?.rev?.price_0 ?? 0) !== 0) ||
    (Number(S?.capex?.[0]?.amount ?? 0) !== 0);
  if (!someSignal) warns.push("Todo está en 0: el modelo va a dar 0 (sirve como base).");

  if (S?.wc?.enabled) {
    const dso = Number(S.wc.dso), dpo = Number(S.wc.dpo), dio = Number(S.wc.dio);
    if (![dso, dpo, dio].every(Number.isFinite)) errors.push("DSO/DPO/DIO deben ser numéricos.");
    if (dso < 0 || dpo < 0 || dio < 0) errors.push("DSO/DPO/DIO no pueden ser negativos.");
    const apShare = Number(S.wc.ap_fixed_share);
    if (!Number.isFinite(apShare) || apShare < 0 || apShare > 1) errors.push("% fijos elegibles AP debe ser 0..1.");
  }

  const ePct = Number(S?.wacc?.e_pct ?? 0), dPct = Number(S?.wacc?.d_pct ?? 0);
  if (![ePct, dPct].every(Number.isFinite)) errors.push("E% y D% deben ser numéricos.");
  if (ePct < 0 || ePct > 1 || dPct < 0 || dPct > 1) errors.push("E% y D% deben estar entre 0 y 1.");
  if (Math.abs((ePct + dPct) - 1) > 1e-6) warns.push("E% + D% no suma 100% (se usa tal cual).");

  if (S?.fin?.enabled) {
    const D0 = Number(S.fin.debt_amount_0);
    const iA = Number(S.fin.interest_rate_annual);
    const term = Number(S.fin.term_months);
    const grace = Number(S.fin.grace_months);
    if (![D0, iA, term, grace].every(Number.isFinite)) errors.push("Deuda: valores inválidos.");
    if (D0 < 0) errors.push("Deuda inicial no puede ser negativa.");
    if (iA < 0) errors.push("Tasa de deuda no puede ser negativa.");
    if (term < 1) errors.push("Plazo de deuda debe ser >= 1.");
    if (grace < 0 || grace > term) errors.push("Gracia debe estar entre 0 y el plazo.");
    if (!["french", "german"].includes(String(S.fin.amortization_type))) errors.push("Sistema debe ser french/german.");
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
      style: { border: "1px solid #c08", padding: "10px", borderRadius: "10px", background: "#fff7ff", marginTop: "8px", whiteSpace: "pre-wrap" }
    }, ["Advertencias:\n- " + warns.join("\n- ")]));
  }
}

/* --------------------------
   8) Render resultados
---------------------------*/
function setText(id, text) {
  const n = byId(id);
  if (!n) return;
  n.textContent = text;
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
  setText("r_dscr_min", res.dscr_min === null ? "N/D" : (isFiniteNum(res.dscr_min) ? res.dscr_min.toFixed(2) : "N/D"));
  setText("r_buffer", fmtMoney(res.buffer_required));

  const fcfeSum = Array.isArray(res.fcfe) ? res.fcfe.reduce((a, b) => a + b, 0) : NaN;
  setText("r_fcfe_sum", fmtMoney(fcfeSum));

  const alertsBox = byId("alertsBox");
  if (!alertsBox) return;
  alertsBox.innerHTML = "";
  const alerts = [];

  if (res.dscr_min !== null && isFiniteNum(res.dscr_min)) {
    if (res.dscr_min < 1.0) alerts.push("🔴 DSCR < 1: no cubre servicio de deuda en al menos un mes.");
    else if (res.dscr_min < 1.2) alerts.push("🟠 DSCR < 1.2: cobertura ajustada.");
  }
  if (isFiniteNum(res.buffer_required) && res.buffer_required > 0) {
    alerts.push(`🔵 Buffer requerido (equity): ${fmtMoney(res.buffer_required)} USD.`);
  }

  if (alerts.length) {
    alertsBox.appendChild(el("div", {
      style: { border: "1px solid #999", padding: "10px", borderRadius: "10px", background: "#f7f7ff", whiteSpace: "pre-wrap" }
    }, [alerts.join("\n")]));
  }
}

function renderTable(df) {
  const host = byId("table");
  if (!host) return;
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
    trh.appendChild(el("th", {
      style: { borderBottom: "1px solid #ddd", padding: "8px", position: "sticky", top: "0", background: "#fff" }
    }, [c]));
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
   9) Cálculo principal
---------------------------*/
function doCalc() {
  if (!window.FinanceEngine || !window.FinanceEngine.buildCashflowTable) {
    alert("No se cargó engine.js (FinanceEngine). Revisá el orden de scripts en index.html.");
    return null;
  }

  const S = readStateFromUI();
  renderWaccCaption(S);

  const { errors, warns } = validateInputs(S);
  renderMessages(errors, warns);
  if (errors.length) return null;

  let res;
  try {
    res = window.FinanceEngine.buildCashflowTable(S);
  } catch (e) {
    alert("Error en el motor de cálculo: " + (e?.message || String(e)));
    return null;
  }

  renderKPIs(res);
  renderTable(res.df);

  saveLastState(S);
  saveLastResult(res);

  // JSON actualizado
  const payload = { ...deepClone(S), meta: { exported_at: new Date().toISOString() } };
  const area = byId("jsonArea");
  if (area) area.value = JSON.stringify(payload, null, 2);

  // ir a resultados
  byId("tabResults").click();

  return { S, res };
}

/* --------------------------
   10) Escenarios
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
    const opt = el("option", { value: n }, [n]);
    if (n === selected) opt.selected = true;
    list.appendChild(opt);
  }
}

function saveScenario() {
  const name = safeName(byId("scName")?.value);
  if (!name) { alert("Poné un nombre de escenario."); byId("scName")?.focus(); return; }

  const S = readStateFromUI();
  const payload = { S, meta: { savedAt: new Date().toISOString() } };

  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(payload));

  const idx = new Set(getIndex());
  idx.add(name);
  setIndex([...idx]);

  refreshScenarioList(name);
  fillCompareSelectors();
  doCalc();
}

function loadScenario() {
  const list = byId("scList");
  const name = safeName(list?.value);
  if (!name) return;

  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) { alert("No se encontró el escenario."); return; }

  let payload;
  try { payload = JSON.parse(raw); } catch { alert("Escenario corrupto."); return; }
  if (!payload || !payload.S) { alert("Escenario inválido (sin estado)."); return; }

  writeStateToUI(payload.S);
  byId("scName").value = name;
  renderWaccCaption(payload.S);

  saveLastState(payload.S);
  doCalc();
}

function deleteScenario() {
  const list = byId("scList");
  const name = safeName(list?.value);
  if (!name) return;

  if (!confirm(`Eliminar escenario "${name}"?`)) return;

  localStorage.removeItem(DATA_PREFIX + name);
  setIndex(getIndex().filter(n => n !== name));

  refreshScenarioList("");
  fillCompareSelectors();
  refreshCompareUI();
}

function newScenario() {
  const S0 = deepClone(DEFAULT_STATE);
  writeStateToUI(S0);
  byId("scName").value = "";
  renderWaccCaption(S0);
  renderMessages([], []);
  saveLastState(S0);
}

/* --------------------------
   11) JSON Import/Export
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
  saveLastState(S);
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
   12) Comparación A vs B
---------------------------*/
function getScenarioStateByName(name) {
  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    return payload?.S || null;
  } catch { return null; }
}

function calcFromState(S) {
  const { errors } = validateInputs(S);
  if (errors.length) return { ok: false, errors };
  try {
    const res = window.FinanceEngine.buildCashflowTable(S);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, errors: ["Falló el motor de cálculo: " + (e?.message || String(e))] };
  }
}

function fillCompareSelectors() {
  const selA = byId("cmpA");
  const selB = byId("cmpB");
  if (!selA || !selB) return;

  const names = getIndex().slice().sort((a,b)=>a.localeCompare(b));
  selA.innerHTML = "";
  selB.innerHTML = "";

  if (!names.length) {
    selA.appendChild(el("option", { value: "" }, ["(sin escenarios)"]));
    selB.appendChild(el("option", { value: "" }, ["(sin escenarios)"]));
    return;
  }

  for (const n of names) {
    selA.appendChild(el("option", { value: n }, [n]));
    selB.appendChild(el("option", { value: n }, [n]));
  }

  selA.value = names[0];
  selB.value = names[1] || names[0];
}

function refreshCompareUI() {
  fillCompareSelectors();
}

function renderCompareKPIs(nameA, resA, nameB, resB) {
  const host = byId("cmpKPIs");
  if (!host) return;
  host.innerHTML = "";

  const rows = [
    ["VAN (USD)", resA.van, resB.van, "money"],
    ["TIR anual eq.", resA.tir_a, resB.tir_a, "pct"],
    ["Payback (mes)", resA.payback, resB.payback, "int"],
    ["Payback desc. (mes)", resA.discounted_payback, resB.discounted_payback, "int"],
    ["DSCR mínimo", resA.dscr_min, resB.dscr_min, "dscr"],
    ["Buffer requerido (USD)", resA.buffer_required, resB.buffer_required, "money"],
  ];

  const fmt = (v, kind) => {
    if (kind === "pct") return Number.isFinite(v) ? fmtPct(v) : "N/D";
    if (kind === "int") return (v === null || v === undefined) ? "N/D" : String(v);
    if (kind === "dscr") return Number.isFinite(v) ? v.toFixed(2) : "N/D";
    return Number.isFinite(v) ? fmtMoney(v) : "N/D";
  };

  const table = el("table", { style:{ width:"100%", borderCollapse:"collapse", fontSize:"12px", border:"1px solid #ddd", borderRadius:"10px", overflow:"hidden" }});
  const thead = el("thead");
  thead.appendChild(el("tr", {}, [
    el("th",{style:"padding:8px;border-bottom:1px solid #ddd;text-align:left"},"Métrica"),
    el("th",{style:"padding:8px;border-bottom:1px solid #ddd;text-align:right"}, nameA),
    el("th",{style:"padding:8px;border-bottom:1px solid #ddd;text-align:right"}, nameB),
    el("th",{style:"padding:8px;border-bottom:1px solid #ddd;text-align:right"}, "Δ (B-A)"),
  ]));
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const [m, a, b, kind] of rows) {
    const delta = (Number.isFinite(b) && Number.isFinite(a)) ? (b - a) : NaN;
    let deltaTxt = "N/D";
    if (Number.isFinite(delta)) {
      if (kind === "pct") deltaTxt = fmtPct(delta);
      else if (kind === "int") deltaTxt = String(delta);
      else if (kind === "dscr") deltaTxt = delta.toFixed(2);
      else deltaTxt = fmtMoney(delta);
    }

    tbody.appendChild(el("tr", {}, [
      el("td",{style:"padding:8px;border-bottom:1px solid #f0f0f0"}, m),
      el("td",{style:"padding:8px;border-bottom:1px solid #f0f0f0;text-align:right"}, fmt(a, kind)),
      el("td",{style:"padding:8px;border-bottom:1px solid #f0f0f0;text-align:right"}, fmt(b, kind)),
      el("td",{style:"padding:8px;border-bottom:1px solid #f0f0f0;text-align:right"}, deltaTxt),
    ]));
  }
  table.appendChild(tbody);

  host.appendChild(table);
}

function renderCompareTableDelta(dfA, dfB) {
  const host = byId("cmpTable");
  if (!host) return;
  host.innerHTML = "";

  if (!Array.isArray(dfA) || !Array.isArray(dfB) || !dfA.length || !dfB.length) {
    host.appendChild(el("div", { style:{padding:"10px"} }, ["Sin datos para comparar."]));
    return;
  }

  const mapA = new Map(dfA.map(r => [r.Mes, r]));
  const mapB = new Map(dfB.map(r => [r.Mes, r]));

  const cols = [
    ["Ingresos", "Ingresos"],
    ["EBITDA", "EBITDA"],
    ["FCFF_mes", "FCFF_mes"],
    ["FCFE_mes", "FCFE_mes"],
    ["Servicio_deuda", "Servicio_deuda"],
    ["DSCR", "DSCR"],
  ];

  const rows = [];
  const maxMes = Math.max(dfA[dfA.length-1].Mes, dfB[dfB.length-1].Mes);

  for (let m = 1; m <= maxMes; m++) {
    const a = mapA.get(m), b = mapB.get(m);
    if (!a || !b) continue;

    const row = { Mes: m };
    for (const [label, key] of cols) {
      const va = Number(a[key]), vb = Number(b[key]);
      row[label] = (Number.isFinite(va) && Number.isFinite(vb)) ? (vb - va) : "";
    }
    rows.push(row);
  }

  const table = el("table", { style:{ width:"100%", borderCollapse:"collapse", fontSize:"12px" }});
  const thead = el("thead");
  const headRow = el("tr");
  const headCols = ["Mes", ...cols.map(c => `Δ ${c[0]}`)];
  for (const c of headCols) {
    headRow.appendChild(el("th", { style:"padding:8px;border-bottom:1px solid #ddd;position:sticky;top:0;background:#fff;text-align:right" }, [c]));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    tr.appendChild(el("td",{style:"padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right"}, String(r.Mes)));
    for (const c of cols) {
      const v = r[c[0]];
      tr.appendChild(el("td",{style:"padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:right"}, (typeof v === "number" ? v.toFixed(2) : "")));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  host.appendChild(table);
}

function compareScenarios() {
  if (!window.FinanceEngine || !window.FinanceEngine.buildCashflowTable) {
    alert("No se cargó engine.js (FinanceEngine).");
    return;
  }

  const nameA = safeName(byId("cmpA")?.value);
  const nameB = safeName(byId("cmpB")?.value);
  if (!nameA || !nameB) return alert("Elegí escenarios A y B.");

  const SA = getScenarioStateByName(nameA);
  const SB = getScenarioStateByName(nameB);
  if (!SA || !SB) return alert("No pude leer uno de los escenarios (¿se borró?).");

  const ca = calcFromState(SA);
  const cb = calcFromState(SB);

  if (!ca.ok) return alert(`Escenario A inválido:\n- ${ca.errors.join("\n- ")}`);
  if (!cb.ok) return alert(`Escenario B inválido:\n- ${cb.errors.join("\n- ")}`);

  renderCompareKPIs(nameA, ca.res, nameB, cb.res);
  renderCompareTableDelta(ca.res.df, cb.res.df);
}

/* --------------------------
   13) Wire up
---------------------------*/
function wire() {
  ensureUI();

  // Cargar último estado si existe; si no, todo en cero
  const last = loadLastState();
  const initial = last ? last : deepClone(DEFAULT_STATE);
  writeStateToUI(initial);
  renderWaccCaption(readStateFromUI());
  renderMessages([], []);

  refreshScenarioList("");
  refreshCompareUI();

  // Botones principales
  byId("btnCalc").addEventListener("click", doCalc);
  byId("btnReset").addEventListener("click", () => { newScenario(); });

  // Escenarios
  byId("btnSaveSc").addEventListener("click", saveScenario);
  byId("btnLoadSc").addEventListener("click", loadScenario);
  byId("btnDelSc").addEventListener("click", deleteScenario);
  byId("btnNewSc").addEventListener("click", newScenario);

  // JSON
  byId("btnExportJSON").addEventListener("click", exportJSONToArea);
  byId("btnImportJSON").addEventListener("click", importJSONFromArea);
  byId("btnDownloadJSON").addEventListener("click", downloadJSON);
  byId("btnLoadFileJSON").addEventListener("click", loadJSONFile);

  // Compare
  const btnCompare = byId("btnCompare");
  if (btnCompare) btnCompare.addEventListener("click", compareScenarios);

  // WACC caption live
  const waccIds = ["e_pct","d_pct","rf","mrp","beta","spread","wacc_tax_rate"];
  for (const id of waccIds) {
    const e = byId(id);
    if (e) e.addEventListener("input", () => renderWaccCaption(readStateFromUI()));
  }

  // Restaurar última pestaña
  const tab = loadLastTab();
  if (tab === "results") byId("tabResults").click();
  else if (tab === "compare") byId("tabCompare").click();
  else if (tab === "json") byId("tabJSON").click();
  else byId("tabInputs").click();

  // Repintar último resultado si existe (sin recalcular)
  const lastRes = loadLastResult();
  if (lastRes && lastRes.df) {
    try {
      renderKPIs(lastRes);
      renderTable(lastRes.df);
      // JSON (si existe área)
      const S = readStateFromUI();
      const payload = { ...deepClone(S), meta: { exported_at: new Date().toISOString() } };
      const area = byId("jsonArea");
      if (area) area.value = JSON.stringify(payload, null, 2);
    } catch {}
  }

  // Asegurar selects de compare
  fillCompareSelectors();
}

window.addEventListener("load", wire);

