/* engine.js
 * Motor financiero (port de app.py):
 * - WACC (mensual) + VAN + TIR (mensual/anual eq) + Payback + Payback descontado
 * - Tabla mensual: volumen, precio, ingresos, opex, EBITDA, impuestos, ΔWC, CapEx, FCFF
 * - Capa CFO opcional: deuda (francesa/alemana con gracia), FCFE, DSCR, buffer equity
 *
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

  function annualToMonthly(i_a) {
    // (1+i_a)^(1/12)-1
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
    // Newton-Raphson, como Python
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
        const denom = Math.pow(1 + r, t);
        f += cf[t] / denom;
        if (t > 0) {
          fp += (-t * cf[t]) / Math.pow(1 + r, t + 1);
        }
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
    // Ke = Rf + beta*MRP
    const ke = w.rf + w.beta * w.mrp;
    // Kd = Rf + spread
    const kd = w.rf + w.spread;
    // WACC anual
    const waccA = w.e_pct * ke + w.d_pct * kd * (1 - w.tax_rate);
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

    if (!(D0 > 0) || termMonths <= 0) {
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

  // ---------- Core calc (port de build_cashflow_table) ----------
  function buildCashflowTable(S) {
    const project = S.project;
    const rev = S.rev;
    const cost = S.cost;
    const wc = S.wc;
    const wacc = S.wacc;
    const capex = S.capex || [];
    const fin = S.fin;

    const n = Math.trunc(project.horizon_months);
    const months = Array.from({ length: n }, (_, i) => i + 1);

    // Revenue drivers
    const vol = new Array(n).fill(0);
    const price = new Array(n).fill(0);
    vol[0] = safeFloat(rev.volume_0, 0);
    price[0] = safeFloat(rev.price_0, 0);

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

    fixed[0] = safeFloat(cost.fixed_0, 0);
    varUnit[0] = safeFloat(cost.var_unit_0, 0);
    maint[0] = safeFloat(cost.maintenance_0, 0);

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
      const mi = Math.trunc(r.month_index);
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
    const finEnabled = !!(fin && fin.enabled);
    const debt = buildDebtSchedule(
      finEnabled ? safeFloat(fin.debt_amount_0, 0) : 0,
      finEnabled ? safeFloat(fin.interest_rate_annual, 0) : 0,
      finEnabled ? Math.trunc(fin.term_months) : 0,
      finEnabled ? Math.trunc(fin.grace_months) : 0,
      finEnabled ? String(fin.amortization_type || "french") : "french",
      n
    );

    const interest = debt.interest;
    const principal = debt.principal;
    const service = debt.debt_service;

    // FOD = EBITDA - tax - ΔWC
    const fod = ebitda.map((e, i) => e - tax[i] - dWc[i]);

    // DSCR
    const dscr = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (service[i] > 1e-12) dscr[i] = fod[i] / service[i];
    }
    let dscrMin = null;
    for (const x of dscr) {
      if (isFiniteNum(x)) dscrMin = dscrMin === null ? x : Math.min(dscrMin, x);
    }

    // FCFE includes t=0
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

    // buffer equity
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
    const dpbE = discountedPaybackMonth(fcfe, waccM); // proxy como Python

    // "df" como array de objetos (equivalente a DataFrame)
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

  global.FinanceEngine = {
    annualToMonthly,
    npv,
    irrMonthly,
    paybackMonth,
    discountedPaybackMonth,
    computeWacc,
    buildDebtSchedule,
    buildCashflowTable,
  };
})(window);
