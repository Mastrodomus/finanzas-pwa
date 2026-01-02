/* engine.js
 * Motor financiero (port de app.py)
 * Se expone como window.FinanceEngine
 */
(function (global) {
  "use strict";

  // ---------- utils ----------
  const isFiniteNum = (x) => Number.isFinite(x) && !Number.isNaN(x);

  function safeFloat(x, def = 0) {
    const v = Number(x);
    return isFiniteNum(v) ? v : def;
  }

  function safeInt(x, def = 0) {
    const v = Number(x);
    return Number.isInteger(v) ? v : (isFiniteNum(v) ? Math.trunc(v) : def);
  }

  function annualToMonthly(i_a) {
    return Math.pow(1 + i_a, 1 / 12) - 1;
  }

  function npv(rate, cashflows) {
    let s = 0;
    for (let t = 0; t < cashflows.length; t++) {
      s += cashflows[t] / Math.pow(1 + rate, t);
    }
    return s;
  }

  function irrMonthly(cashflows, guess = 0.01) {
    const cf = cashflows.map(Number);
    if (cf.length < 2) return null;

    let allPos = true, allNeg = true;
    for (const x of cf) {
      if (x < 0) allPos = false;
      if (x > 0) allNeg = false;
    }
    if (allPos || allNeg) return null;

    let r = guess;
    for (let it = 0; it < 200; it++) {
      let f = 0;
      let fp = 0;
      for (let t = 0; t < cf.length; t++) {
        f += cf[t] / Math.pow(1 + r, t);
        fp += (-t * cf[t]) / Math.pow(1 + r, t + 1); // t=0 aporta 0, pero queda 1:1 con Python
      }
      if (Math.abs(fp) < 1e-12) break;

      const rNew = r - f / fp;
      if (!isFiniteNum(rNew) || rNew <= -0.9999) break;
      if (Math.abs(rNew - r) < 1e-10) return rNew;
      r = rNew;
    }
    return null;
  }

  function paybackMonth(cashflows) {
    let cum = 0;
    for (let t = 0; t < cashflows.length; t++) {
      cum += cashflows[t];
      if (cum >= 0) return t;
    }
    return null;
  }

  function discountedPaybackMonth(cashflows, rate) {
    const disc = cashflows.map((cf, t) => cf / Math.pow(1 + rate, t));
    return paybackMonth(disc);
  }

  // ---------- WACC ----------
  function computeWacc(w) {
    const e = safeFloat(w.e_pct, 0);
    const d = safeFloat(w.d_pct, 0);
    const rf = safeFloat(w.rf, 0);
    const mrp = safeFloat(w.mrp, 0);
    const beta = safeFloat(w.beta, 0);
    const spread = safeFloat(w.spread, 0);
    const taxRate = safeFloat(w.tax_rate, 0);

    const ke = rf + beta * mrp;
    const kd = rf + spread;
    const waccA = e * ke + d * kd * (1 - taxRate);
    const waccM = annualToMonthly(waccA);
    return { ke, waccA, waccM };
  }

  // ---------- Debt schedule ----------
  function buildDebtSchedule(D0, iA, termMonths, graceMonths, amortType, horizonMonths) {
    const nH = horizonMonths;

    const balStart = new Array(nH).fill(0);
    const interest = new Array(nH).fill(0);
    const principal = new Array(nH).fill(0);
    const service = new Array(nH).fill(0);
    const balEnd = new Array(nH).fill(0);

    if (!(D0 > 0) || termMonths <= 0 || nH <= 0) {
      return { balance_start: balStart, interest, principal, debt_service: service, balance_end: balEnd };
    }

    const n = Math.min(termMonths, nH);
    const g = Math.min(Math.max(graceMonths, 0), n);
    const nEff = n - g;

    const iM = annualToMonthly(iA);
    let bal = D0;

    let pmt = 0;
    let prinFixed = 0;

    if (nEff > 0) {
      if (amortType === "french") {
        if (Math.abs(iM) < 1e-12) pmt = D0 / nEff;
        else pmt = D0 * (iM * Math.pow(1 + iM, nEff)) / (Math.pow(1 + iM, nEff) - 1);
      } else if (amortType === "german") {
        prinFixed = D0 / nEff;
      } else {
        throw new Error("amortization_type debe ser 'french' o 'german'");
      }
    }

    for (let t = 0; t < nH; t++) {
      if (t >= n) continue;

      balStart[t] = bal;
      interest[t] = bal * iM;

      if (t < g || nEff <= 0) {
        principal[t] = 0;
        service[t] = interest[t];
        balEnd[t] = bal;
      } else {
        if (amortType === "french") {
          principal[t] = Math.max(0, pmt - interest[t]);
          service[t] = principal[t] + interest[t];
        } else {
          principal[t] = prinFixed;
          service[t] = principal[t] + interest[t];
        }

        bal = bal - principal[t];
        if (bal < 0 && bal > -1e-6) bal = 0;
        balEnd[t] = Math.max(bal, 0);
      }
    }

    return { balance_start: balStart, interest, principal, debt_service: service, balance_end: balEnd };
  }

  // ---------- Core calc ----------
  function buildCashflowTable(S) {
    if (!S || !S.project || !S.rev || !S.cost || !S.wc || !S.wacc) {
      throw new Error("Estado inválido: faltan secciones (project/rev/cost/wc/wacc).");
    }

    // Normalización total (evita NaNs por inputs de UI)
    const project = {
      horizon_months: safeInt(S.project.horizon_months, 60),
      tax_rate: safeFloat(S.project.tax_rate, 0.3),
    };

    const rev = {
      volume_0: safeFloat(S.rev.volume_0, 0),
      volume_growth_m: safeFloat(S.rev.volume_growth_m, 0),
      capacity_max: safeFloat(S.rev.capacity_max, 0),
      collection_factor: safeFloat(S.rev.collection_factor, 1),
      price_0: safeFloat(S.rev.price_0, 0),
      price_growth_m: safeFloat(S.rev.price_growth_m, 0),
    };

    const cost = {
      fixed_0: safeFloat(S.cost.fixed_0, 0),
      fixed_growth_m: safeFloat(S.cost.fixed_growth_m, 0),
      var_unit_0: safeFloat(S.cost.var_unit_0, 0),
      var_unit_growth_m: safeFloat(S.cost.var_unit_growth_m, 0),
      maintenance_0: safeFloat(S.cost.maintenance_0, 0),
      maintenance_growth_m: safeFloat(S.cost.maintenance_growth_m, 0),
    };

    const wc = {
      enabled: !!S.wc.enabled,
      dso: safeFloat(S.wc.dso, 0),
      dpo: safeFloat(S.wc.dpo, 0),
      dio: safeFloat(S.wc.dio, 0),
      ap_fixed_share: safeFloat(S.wc.ap_fixed_share, 0),
    };

    const wacc = {
      e_pct: safeFloat(S.wacc.e_pct, 0.6),
      d_pct: safeFloat(S.wacc.d_pct, 0.4),
      rf: safeFloat(S.wacc.rf, 0),
      mrp: safeFloat(S.wacc.mrp, 0),
      beta: safeFloat(S.wacc.beta, 1),
      spread: safeFloat(S.wacc.spread, 0),
      tax_rate: safeFloat(S.wacc.tax_rate, project.tax_rate),
    };

    const capex = Array.isArray(S.capex) ? S.capex : [];
    const fin = S.fin || { enabled: false };

    const n = project.horizon_months;
    if (n < 1) throw new Error("Horizonte inválido (horizon_months).");

    const months = Array.from({ length: n }, (_, i) => i + 1);

    // Revenue drivers
    const vol = new Array(n).fill(0);
    const price = new Array(n).fill(0);
    vol[0] = rev.volume_0;
    price[0] = rev.price_0;

    for (let t = 1; t < n; t++) {
      vol[t] = Math.min(rev.capacity_max, vol[t - 1] * (1 + rev.volume_growth_m));
      price[t] = price[t - 1] * (1 + rev.price_growth_m);
    }

    const revenueGross = vol.map((v, i) => v * price[i]);
    const revenue = revenueGross.map((x) => x * rev.collection_factor);

    // Costs
    const fixed = new Array(n).fill(0);
    const varUnit = new Array(n).fill(0);
    const maint = new Array(n).fill(0);

    fixed[0] = cost.fixed_0;
    varUnit[0] = cost.var_unit_0;
    maint[0] = cost.maintenance_0;

    for (let t = 1; t < n; t++) {
      fixed[t] = fixed[t - 1] * (1 + cost.fixed_growth_m);
      varUnit[t] = varUnit[t - 1] * (1 + cost.var_unit_growth_m);
      maint[t] = maint[t - 1] * (1 + cost.maintenance_growth_m);
    }

    const varCost = vol.map((v, i) => v * varUnit[i]);
    const opex = fixed.map((f, i) => f + varCost[i] + maint[i]);
    const ebitda = revenue.map((r, i) => r - opex[i]);

    // Tax on positive EBITDA
    const tax = ebitda.map((e) => (e > 0 ? e * project.tax_rate : 0));

    // Working capital delta
    const dWc = new Array(n).fill(0);
    if (wc.enabled) {
      const ar = revenue.map((r) => r * (wc.dso / 30));
      const ap = varCost.map((vc, i) => (vc + fixed[i] * wc.ap_fixed_share) * (wc.dpo / 30));
      const inv = varCost.map((vc) => vc * (wc.dio / 30));
      const wcLevel = ar.map((x, i) => x + inv[i] - ap[i]);
      dWc[0] = wcLevel[0];
      for (let t = 1; t < n; t++) dWc[t] = wcLevel[t] - wcLevel[t - 1];
    }

    // CapEx by month
    const capexByMonth = new Array(n).fill(0);
    for (const r of capex) {
      const mi = safeInt(r.month_index, 0);
      if (mi >= 0 && mi < n) capexByMonth[mi] += safeFloat(r.amount, 0);
    }

    // FCFF includes t=0
    const fcff = new Array(n + 1).fill(0);
    fcff[0] = -capexByMonth[0] - dWc[0];
    for (let t = 1; t <= n; t++) {
      const idx = t - 1;
      fcff[t] = (ebitda[idx] - tax[idx]) - dWc[idx] - capexByMonth[idx];
    }

    // WACC / KPIs
    const { ke, waccA, waccM } = computeWacc(wacc);
    const van = npv(waccM, fcff);
    const tirM = irrMonthly(fcff);
    const tirA = tirM === null ? null : Math.pow(1 + tirM, 12) - 1;
    const pb = paybackMonth(fcff);
    const dpb = discountedPaybackMonth(fcff, waccM);

    // CFO layer
    const finEnabled = !!fin.enabled;
    const debt = buildDebtSchedule(
      finEnabled ? safeFloat(fin.debt_amount_0, 0) : 0,
      finEnabled ? safeFloat(fin.interest_rate_annual, 0) : 0,
      finEnabled ? safeInt(fin.term_months, 0) : 0,
      finEnabled ? safeInt(fin.grace_months, 0) : 0,
      finEnabled ? String(fin.amortization_type || "french") : "french",
      n
    );

    const interest = debt.interest;
    const principal = debt.principal;
    const service = debt.debt_service;

    const fod = ebitda.map((e, i) => e - tax[i] - dWc[i]);

    const dscr = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (service[i] > 1e-12) dscr[i] = fod[i] / service[i];
    }
    let dscrMin = null;
    for (const x of dscr) if (isFiniteNum(x)) dscrMin = dscrMin === null ? x : Math.min(dscrMin, x);

    const fcfe = new Array(n + 1).fill(0);
    const capex0 = capexByMonth[0];
    const dwc0 = dWc[0];
    const D0 = finEnabled ? safeFloat(fin.debt_amount_0, 0) : 0;

    fcfe[0] = D0 - (capex0 + dwc0);

    for (let t = 1; t <= n; t++) {
      const idx = t - 1;
      const taxShield = (finEnabled && fin.tax_shield_enabled) ? (interest[idx] * project.tax_rate) : 0;
      fcfe[t] = fcff[t] - interest[idx] - principal[idx] + taxShield;
    }

    let equityCum = 0;
    let minEquityCum = 0;
    for (const x of fcfe) {
      equityCum += x;
      if (equityCum < minEquityCum) minEquityCum = equityCum;
    }
    const bufferRequired = Math.abs(minEquityCum);

    const irrEM = irrMonthly(fcfe);
    const irrEA = irrEM === null ? null : Math.pow(1 + irrEM, 12) - 1;
    const pbE = paybackMonth(fcfe);
    const dpbE = discountedPaybackMonth(fcfe, waccM);

    const df = months.map((m, i) => ({
      Mes: m,
      Volumen: vol[i],
      Precio: price[i],
      Ingresos: revenue[i],
      Costos_fijos: fixed[i],
      Costos_variables: varCost[i],
      Mantenimiento: maint[i],
      Opex_total: opex[i],
      EBITDA: ebitda[i],
      Impuestos: tax[i],
      "ΔWC": dWc[i],
      CapEx: capexByMonth[i],
      FCFF_mes: fcff[i + 1],
      FOD: fod[i],
      Intereses: interest[i],
      "Amortización": principal[i],
      Servicio_deuda: service[i],
      DSCR: dscr[i],
      FCFE_mes: fcfe[i + 1],
    }));

    return {
      df,
      fcff,
      fcfe,
      wacc_m: waccM,
      ke,
      wacc_a: waccA,
      van,
      tir_m: tirM,
      tir_a: tirA,
      payback: pb,
      discounted_payback: dpb,
      dscr_min: dscrMin,
      buffer_required: bufferRequired,
      irr_e_m: irrEM,
      irr_e_a: irrEA,
      payback_equity: pbE,
      discounted_payback_equity: dpbE,
    };
  }

  // ---------- Golden tests (opcional: ejecutar en consola) ----------
  function runSelfTests() {
    const cases = [
      {
        name: "Base sin deuda",
        S: {
          project: { horizon_months: 60, tax_rate: 0.30 },
          rev: { volume_0: 200, volume_growth_m: 0.01, capacity_max: 500, collection_factor: 0.98, price_0: 150, price_growth_m: 0.008 },
          cost: { fixed_0: 12000, fixed_growth_m: 0.007, var_unit_0: 25, var_unit_growth_m: 0.007, maintenance_0: 900, maintenance_growth_m: 0.007 },
          wc: { enabled: true, dso: 90, dpo: 60, dio: 0, ap_fixed_share: 0.25 },
          wacc: { e_pct: 0.60, d_pct: 0.40, rf: 0.045, mrp: 0.055, beta: 1.10, spread: 0.03, tax_rate: 0.30 },
          capex: [{ month_index: 0, item: "Inicial", amount: 730000 }],
          fin: { enabled: false }
        }
      },
    ];

    const out = [];
    for (const c of cases) {
      const r = buildCashflowTable(c.S);
      out.push({
        case: c.name,
        van: r.van,
        wacc_m: r.wacc_m,
        tir_m: r.tir_m,
        payback: r.payback,
        dscr_min: r.dscr_min,
        buffer: r.buffer_required,
      });
    }
    return out;
  }

  global.FinanceEngine = {
    annualToMonthly,
    npv,
    irrMonthly,
    paybackMonth,
    discountedPaybackMonth,
    computeWacc,
    buildDebtSchedule,
    buildCashflowTable,
    runSelfTests,
  };
})(window);
