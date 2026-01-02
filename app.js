/* app.js (completo, listo para copiar/pegar)
   - UI completa (no depende de HTML previo)
   - Lee/escribe estado S (shape igual a default_state() Python)
   - KPIs + tabla mensual
   - CapEx multi-mes (tabla dinámica)
   - Escenarios (guardar/cargar/eliminar) en localStorage
   - Import/Export JSON (textarea + archivo + descarga)
   - Registro SW (PWA) si existe sw.js
   Requiere en index.html:
     <script src="./engine.js"></script>
     <script src="./app.js"></script>
*/

"use strict";

/* --------------------------
   0) PWA SW register
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
   1) Default state (idéntico a default_state() Python)
---------------------------*/
const DEFAULT_STATE = {
  project: { name: "Resonador", start_yyyymm: "2026-01", horizon_months: 60, tax_rate: 0.30 },
  rev: {
    volume_0: 200.0,
    volume_growth_m: 0.01,
    capacity_max: 500.0,
    collection_factor: 0.98,
    price_0: 150.0,
    price_growth_m: 0.008,
  },
  cost: {
    fixed_0: 12000.0,
    fixed_growth_m: 0.007,
    var_unit_0: 25.0,
    var_unit_growth_m: 0.007,
    maintenance_0: 900.0,
    maintenance_growth_m: 0.007,
  },
  wc: { enabled: true, dso: 90, dpo: 60, dio: 0, ap_fixed_share: 0.25 },
  wacc: { e_pct: 0.60, d_pct: 0.40, rf: 0.045, mrp: 0.055, beta: 1.10, spread: 0.03, tax_rate: 0.30 },
  capex: [{ month_index: 0, item: "Inversión inicial", amount: 730000.0 }],
  fin: {
    enabled: false,
    debt_amount_0: 0.0,
    interest_rate_annual: 0.18,
    term_months: 60,
    grace_months: 0,
    amortization_type: "french",
    tax_shield_enabled: false,
  },
};

/* --------------------------
   2) Storage escenarios
---------------------------*/
const INDEX_KEY = "finanzas.scenarios.index.v3";
const DATA_PREFIX = "finanzas.scenario.v3.";

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

/* --------------------------
   4) UI: se crea completa (no depende de tu HTML)
---------------------------*/
function ensureUI() {
  let root = byId("appRoot");
  if (root) return root;

  root = el("div", {
    id: "appRoot",
    style: {
      maxWidth: "1100px",
      margin: "0 auto",
      padding: "16px",
      fontFamily: "system-ui, Segoe UI, Arial",
      lineHeight: "1.3",
    }
  });

  const topBar = el("div", {
    style: {
      display: "flex",
      gap: "12px",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: "12px"
    }
  }, [
    el("div", {}, [
      el("div", { style: { fontSize: "20px", fontWeight: "700" } }, ["Modelo de inversión (offline)"]),
      el("div", { style: { fontSize: "12px", opacity: "0.8" } }, ["FCFF mensual nominal (USD) + WACC + (opcional) deuda/FCFE/DSCR/buffer"])
    ]),
    el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, [
      el("button", { id: "btnCalc", type: "button" }, ["Calcular"]),
      el("button", { id: "btnReset", type: "button" }, ["Reset"]),
    ])
  ]);

  const tabs = el("div", { style: { display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" } }, [
    el("button", { id: "tabInputs", type: "button", "data-tab": "inputs" }, ["Inputs"]),
    el("button", { id: "tabResults", type: "button", "data-tab": "results" }, ["Resultados"]),
    el("button", { id: "tabJSON", type: "button", "data-tab": "json" }, ["JSON"]),
  ]);

  const msg = el("div", { id: "msgBox", style: { marginBottom: "12px" } });

  const viewInputs = el("div", { id: "view_inputs" });
  const viewResults = el("div", { id: "view_results", style: { display: "none" } });
  const viewJSON = el("div", { id: "view_json", style: { display: "none" } });

  root.appendChild(topBar);
  root.appendChild(tabs);
  root.appendChild(msg);
  root.appendChild(viewInputs);
  root.appendChild(viewResults);
  root.appendChild(viewJSON);

  document.body.appendChild(root);

  buildInputsView(viewInputs);
  buildResultsView(viewResults);
  buildJSONView(viewJSON);

  function activate(tab) {
    viewInputs.style.display = tab === "inputs" ? "" : "none";
    viewResults.style.display = tab === "results" ? "" : "none";
    viewJSON.style.display = tab === "json" ? "" : "none";
  }
  byId("tabInputs").addEventListener("click", () => activate("inputs"));
  byId("tabResults").addEventListener("click", () => activate("results"));
  byId("tabJSON").addEventListener("click", () => activate("json"));

  activate("inputs");
  return root;
}

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
   5) CapEx table helpers
---------------------------*/
function renderCapexTable(rows) {
  const host = byId("capexTable");
  if (!host) return;
  host.innerHTML = "";

  const data = Array.isArray(rows) && rows.length ? rows : deepClone(DEFAULT_STATE.capex);

  const table = el("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } });
  const thead = el("thead");
  thead.appendChild(el("tr", {}, [
    el("th", { style: { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px" } }, ["month_index"]),
    el("th", { style: { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px" } }, ["item"]),
    el("th", { style: { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px" } }, ["amount"]),
    el("th", { style: { borderBottom: "1px solid #ddd", padding: "6px" } }, [""]),
  ]));
  table.appendChild(thead);

  const tbody = el("tbody");
  data.forEach((r, idx) => {
    const mi = el("input", { type: "number", step: "1", value: String(r.month_index ?? 0), "data-capex": "mi" });
    const it = el("input", { type: "text", value: String(r.item ?? ""), "data-capex": "item" });
    const am = el("input", { type: "number", step: "any", value: String(r.amount ?? 0), "data-capex": "amt" });

    const del = el("button", {
      type: "button",
      onclick: () => {
        const current = readCapexFromTable();
        current.splice(idx, 1);
        renderCapexTable(current.length ? current : [{ month_index: 0, item: "Inversión inicial", amount: 0 }]);
      }
    }, ["Eliminar"]);

    tbody.appendChild(el("tr", {}, [
      el("td", { style: { borderBottom: "1px solid #f0f0f0", padding: "6px" } }, [mi]),
      el("td", { style: { borderBottom: "1px solid #f0f0f0", padding: "6px" } }, [it]),
      el("td", { style: { borderBottom: "1px solid #f0f0f0", padding: "6px" } }, [am]),
      el("td", { style: { borderBottom: "1px solid #f0f0f0", padding: "6px" } }, [del]),
    ]));
  });

  table.appendChild(tbody);
  host.appendChild(table);
}

function readCapexFromTable() {
  const host = byId("capexTable");
  if (!host) return deepClone(DEFAULT_STATE.capex);

  const rows = [];
  const trs = host.querySelectorAll("tbody tr");
  trs.forEach((tr) => {
    const mi = tr.querySelector('input[data-capex="mi"]');
    const it = tr.querySelector('input[data-capex="item"]');
    const am = tr.querySelector('input[data-capex="amt"]');

    const month_index = Math.trunc(Number(mi?.value ?? 0));
    const item = String(it?.value ?? "").trim() || "CapEx";
    const amount = Number(am?.value ?? 0);

    if (Number.isFinite(month_index) && Number.isFinite(amount)) {
      rows.push({ month_index: Math.max(0, month_index), item, amount });
    }
  });

  return rows.length ? rows : deepClone(DEFAULT_STATE.capex);
}

/* --------------------------
   6) Build views
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
      field("Precio inicial (USD)", "price_0", "number", "0.01"),
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
    el("div", { style: { marginBottom: "8px" } }, [ checkbox("Habilitar WC", "wc_enabled") ]),
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

  // CapEx multi-mes
  const capexTable = el("div", { id: "capexTable" });
  const capexBtnRow = el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" } }, [
    el("button", { id: "btnCapexAdd", type: "button" }, ["+ Fila"]),
    el("button", { id: "btnCapexClear", type: "button" }, ["Reset CapEx"]),
  ]);
  const secCapex = section("6) CapEx (multi-mes)", [
    el("div", { style: { fontSize: "12px", opacity: "0.85", marginBottom: "8px" } }, [
      "month_index: 0 = mes inicial. Podés cargar múltiples inversiones o reintegros (monto negativo)."
    ]),
    capexTable,
    capexBtnRow
  ]);

  // Deuda
  const secFin = section("7) Financiamiento (opcional)", [
    el("div", { style: { marginBottom: "8px" } }, [ checkbox("Usar deuda", "fin_enabled") ]),
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
    el("div", { style: { marginTop: "8px" } }, [ checkbox("Escudo fiscal (interés)", "tax_shield_enabled") ])
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
      "Tip: este JSON es el equivalente a tu export/import de Streamlit."
    ])
  ]));
}

/* --------------------------
   7) UI <-> State
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

  S.capex = readCapexFromTable();

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
  writeVal("project_name", S.project.name);
  writeVal("start_yyyymm", S.project.start_yyyymm);
  writeVal("horizon_months", S.project.horizon_months);
  writeVal("tax_rate", S.project.tax_rate);

  writeVal("volume_0", S.rev.volume_0);
  writeVal("volume_growth_m", S.rev.volume_growth_m);
  writeVal("capacity_max", S.rev.capacity_max);
  writeVal("collection_factor", S.rev.collection_factor);
  writeVal("price_0", S.rev.price_0);
  writeVal("price_growth_m", S.rev.price_growth_m);

  writeVal("fixed_0", S.cost.fixed_0);
  writeVal("fixed_growth_m", S.cost.fixed_growth_m);
  writeVal("var_unit_0", S.cost.var_unit_0);
  writeVal("var_unit_growth_m", S.cost.var_unit_growth_m);
  writeVal("maintenance_0", S.cost.maintenance_0);
  writeVal("maintenance_growth_m", S.cost.maintenance_growth_m);

  writeVal("wc_enabled", S.wc.enabled);
  writeVal("dso", S.wc.dso);
  writeVal("dpo", S.wc.dpo);
  writeVal("dio", S.wc.dio);
  writeVal("ap_fixed_share", S.wc.ap_fixed_share);

  writeVal("e_pct", S.wacc.e_pct);
  writeVal("d_pct", S.wacc.d_pct);
  writeVal("rf", S.wacc.rf);
  writeVal("mrp", S.wacc.mrp);
  writeVal("beta", S.wacc.beta);
  writeVal("spread", S.wacc.spread);
  writeVal("wacc_tax_rate", S.wacc.tax_rate);

  renderCapexTable(S.capex);

  writeVal("fin_enabled", S.fin.enabled);
  writeVal("debt_amount_0", S.fin.debt_amount_0);
  writeVal("interest_rate_annual", S.fin.interest_rate_annual);
  writeVal("term_months", S.fin.term_months);
  writeVal("grace_months", S.fin.grace_months);
  writeVal("amortization_type", S.fin.amortization_type);
  writeVal("tax_shield_enabled", S.fin.tax_shield_enabled);
}

/* --------------------------
   8) Validación
---------------------------*/
function validateInputs(S) {
  const errors = [];
  const warns = [];

  if (S.project.horizon_months < 12) warns.push("Horizonte < 12 meses: resultados pueden ser poco representativos.");
  if (!(S.project.tax_rate >= 0 && S.project.tax_rate <= 0.6)) errors.push("Impuesto fuera de rango (0..0.6).");

  if (!(S.rev.capacity_max > 0)) errors.push("Capacidad máxima debe ser > 0.");
  if (!(S.rev.collection_factor >= 0 && S.rev.collection_factor <= 1)) errors.push("Factor cobranza debe estar entre 0 y 1.");

  if (S.wc.enabled) {
    if (S.wc.dso < 0 || S.wc.dpo < 0 || S.wc.dio < 0) errors.push("DSO/DPO/DIO no pueden ser negativos.");
    if (!(S.wc.ap_fixed_share >= 0 && S.wc.ap_fixed_share <= 1)) errors.push("% fijos elegibles en AP debe estar 0..1.");
  }

  if (Math.abs((S.wacc.e_pct + S.wacc.d_pct) - 1.0) > 1e-6) warns.push("E% + D% no suma 100% (se usa tal cual).");
  if (S.wacc.beta < 0) warns.push("Beta negativa: revisar.");
  if (S.wacc.tax_rate < 0 || S.wacc.tax_rate > 0.6) warns.push("Tasa impuesto WACC fuera de rango típico (0..0.6).");

  if (S.fin.enabled) {
    if (S.fin.debt_amount_0 < 0) errors.push("Deuda inicial no puede ser negativa.");
    if (S.fin.interest_rate_annual < 0) errors.push("Tasa deuda no puede ser negativa.");
    if (S.fin.term_months < 1) errors.push("Plazo deuda debe ser >= 1.");
    if (S.fin.grace_months < 0 || S.fin.grace_months > S.fin.term_months) errors.push("Gracia inválida.");
    if (!["french", "german"].includes(S.fin.amortization_type)) errors.push("Sistema debe ser french/german.");
  }

  // CapEx validation
  if (!Array.isArray(S.capex) || S.capex.length === 0) {
    warns.push("CapEx vacío: se asume 0.");
  } else {
    for (const r of S.capex) {
      if (!Number.isFinite(r.month_index) || r.month_index < 0) errors.push("CapEx: month_index no puede ser negativo.");
      if (!Number.isFinite(r.amount)) errors.push("CapEx: amount inválido.");
    }
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
   9) Render resultados
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
  setText("r_dscr_min", res.dscr_min === null ? "N/D" : res.dscr_min.toFixed(2));
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
   10) Cálculo principal
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

  const res = window.FinanceEngine.buildCashflowTable(S);

  renderKPIs(res);
  renderTable(res.df);

  byId("tabResults").click();

  const payload = { ...deepClone(S), meta: { exported_at: new Date().toISOString() } };
  const area = byId("jsonArea");
  if (area) area.value = JSON.stringify(payload, null, 2);

  return { S, res };
}

/* --------------------------
   11) Escenarios
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
  const name = safeName(byId("scName").value);
  if (!name) { alert("Poné un nombre de escenario."); byId("scName").focus(); return; }

  const S = readStateFromUI();
  const payload = { S, meta: { savedAt: new Date().toISOString() } };

  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(payload));

  const idx = new Set(getIndex());
  idx.add(name);
  setIndex([...idx]);

  refreshScenarioList(name);
  doCalc();
}

function loadScenario() {
  const list = byId("scList");
  const name = safeName(list.value);
  if (!name) return;

  const raw = localStorage.getItem(DATA_PREFIX + name);
  if (!raw) { alert("No se encontró el escenario."); return; }

  let payload;
  try { payload = JSON.parse(raw); } catch { alert("Escenario corrupto."); return; }
  if (!payload || !payload.S) { alert("Escenario inválido (sin estado)."); return; }

  writeStateToUI(payload.S);
  byId("scName").value = name;
  renderWaccCaption(payload.S);
  doCalc();
}

function deleteScenario() {
  const list = byId("scList");
  const name = safeName(list.value);
  if (!name) return;

  if (!confirm(`Eliminar escenario "${name}"?`)) return;

  localStorage.removeItem(DATA_PREFIX + name);
  setIndex(getIndex().filter(n => n !== name));
  refreshScenarioList("");
}

function newScenario() {
  const init = deepClone(DEFAULT_STATE);
  writeStateToUI(init);
  byId("scName").value = "";
  renderWaccCaption(init);
  renderMessages([], []);
}

/* --------------------------
   12) JSON Import/Export
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
   13) Wire up
---------------------------*/
function wire() {
  ensureUI();

  const init = deepClone(DEFAULT_STATE);
  writeStateToUI(init);
  renderWaccCaption(init);

  refreshScenarioList("");

  byId("btnCalc").addEventListener("click", doCalc);
  byId("btnReset").addEventListener("click", () => newScenario());

  byId("btnSaveSc").addEventListener("click", saveScenario);
  byId("btnLoadSc").addEventListener("click", loadScenario);
  byId("btnDelSc").addEventListener("click", deleteScenario);
  byId("btnNewSc").addEventListener("click", newScenario);

  byId("btnExportJSON").addEventListener("click", exportJSONToArea);
  byId("btnImportJSON").addEventListener("click", importJSONFromArea);
  byId("btnDownloadJSON").addEventListener("click", downloadJSON);
  byId("btnLoadFileJSON").addEventListener("click", loadJSONFile);

  // WACC caption live
  const waccIds = ["e_pct","d_pct","rf","mrp","beta","spread","wacc_tax_rate"];
  for (const id of waccIds) byId(id).addEventListener("input", () => renderWaccCaption(readStateFromUI()));

  // CapEx buttons
  byId("btnCapexAdd").addEventListener("click", () => {
    const cur = readCapexFromTable();
    cur.push({ month_index: 0, item: "CapEx", amount: 0 });
    renderCapexTable(cur);
  });

  byId("btnCapexClear").addEventListener("click", () => {
    renderCapexTable(deepClone(DEFAULT_STATE.capex));
  });
}

window.addEventListener("load", wire);
