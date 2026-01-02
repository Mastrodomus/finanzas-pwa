# app.py
# ---------------------------------------------
# Modelo de inversión (FCFF mensual nominal USD) + WACC por proyecto
# + Capa CFO: Deuda (francesa/alemana con gracia), FCFE, DSCR, buffer de caja
#
# Requisitos (requirements.txt):
# streamlit
# pandas
# numpy
# openpyxl
# reportlab
# ---------------------------------------------

from __future__ import annotations

import io
import json
import math
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Dict, Optional, Tuple

import numpy as np
import pandas as pd
import streamlit as st
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


# =========================
# Helpers: formatting
# =========================
def fmt_money(x: Optional[float]) -> str:
    if x is None or (isinstance(x, float) and (np.isnan(x) or np.isinf(x))):
        return "N/D"
    return f"{x:,.2f}"

def fmt_pct(x: Optional[float]) -> str:
    if x is None or (isinstance(x, float) and (np.isnan(x) or np.isinf(x))):
        return "N/D"
    return f"{x*100:.2f}%"

def safe_float(x, default=0.0) -> float:
    try:
        return float(x)
    except Exception:
        return float(default)

def annual_to_monthly(i_a: float) -> float:
    # Convierte tasa anual nominal/efectiva a mensual efectiva aproximada (compuesta)
    # i_m = (1+i_a)^(1/12) - 1
    return (1.0 + i_a) ** (1.0 / 12.0) - 1.0


# =========================
# Helpers: finance math
# =========================
def npv(rate: float, cashflows: np.ndarray) -> float:
    # cashflows: [t=0..n]
    return float(np.sum(cashflows / ((1 + rate) ** np.arange(len(cashflows)))))

def irr_monthly(cashflows: np.ndarray, guess: float = 0.01) -> Optional[float]:
    """
    IRR mensual por Newton-Raphson (robusto para uso práctico).
    Devuelve None si no converge o si no hay cambio de signo.
    """
    cf = np.array(cashflows, dtype=float)
    if len(cf) < 2:
        return None
    if np.all(cf >= 0) or np.all(cf <= 0):
        return None  # sin cambio de signo => IRR no definida

    r = guess
    for _ in range(200):
        # f(r) = NPV(r)
        # f'(r) = d/d r sum cf_t / (1+r)^t
        denom = (1 + r) ** np.arange(len(cf))
        f = np.sum(cf / denom)
        # derivada
        t = np.arange(len(cf))
        fp = np.sum(-t * cf / ((1 + r) ** (t + 1)))
        if abs(fp) < 1e-12:
            break
        r_new = r - f / fp
        # control básico
        if not np.isfinite(r_new) or r_new <= -0.9999:
            break
        if abs(r_new - r) < 1e-10:
            return float(r_new)
        r = r_new
    return None

def payback_month(cashflows: np.ndarray) -> Optional[int]:
    # Primer mes t donde acumulado >= 0 (t=0..n). Devuelve t o None.
    cum = np.cumsum(cashflows)
    idx = np.where(cum >= 0)[0]
    if len(idx) == 0:
        return None
    return int(idx[0])

def discounted_payback_month(cashflows: np.ndarray, rate: float) -> Optional[int]:
    disc = cashflows / ((1 + rate) ** np.arange(len(cashflows)))
    return payback_month(disc)


# =========================
# Data models
# =========================
@dataclass
class ProjectModel:
    name: str
    start_yyyymm: str
    horizon_months: int
    tax_rate: float

@dataclass
class RevenueModel:
    volume_0: float
    volume_growth_m: float
    capacity_max: float
    collection_factor: float
    price_0: float
    price_growth_m: float

@dataclass
class CostModel:
    fixed_0: float
    fixed_growth_m: float
    var_unit_0: float
    var_unit_growth_m: float
    maintenance_0: float
    maintenance_growth_m: float

@dataclass
class WorkingCapitalModel:
    enabled: bool
    dso: int
    dpo: int
    dio: int
    ap_fixed_share: float  # 0..1 (cuánto de costos fijos es pagable)

@dataclass
class WaccModel:
    e_pct: float
    d_pct: float
    rf: float
    mrp: float
    beta: float
    spread: float
    tax_rate: float  # normalmente igual al impuesto del proyecto

@dataclass
class CapexRow:
    month_index: int  # 0 = mes inicial
    item: str
    amount: float

@dataclass
class FinancingModel:
    enabled: bool
    debt_amount_0: float
    interest_rate_annual: float
    term_months: int
    grace_months: int
    amortization_type: str   # "french" o "german"
    tax_shield_enabled: bool = False


# =========================
# Default state / JSON IO
# =========================
def default_state() -> Dict:
    return {
        "project": ProjectModel("Resonador", "2026-01", 60, 0.30),
        "rev": RevenueModel(
            volume_0=200.0,
            volume_growth_m=0.01,
            capacity_max=500.0,
            collection_factor=0.98,
            price_0=150.0,
            price_growth_m=0.008,
        ),
        "cost": CostModel(
            fixed_0=12000.0,
            fixed_growth_m=0.007,
            var_unit_0=25.0,
            var_unit_growth_m=0.007,
            maintenance_0=900.0,
            maintenance_growth_m=0.007,
        ),
        "wc": WorkingCapitalModel(
            enabled=True,
            dso=90,
            dpo=60,
            dio=0,
            ap_fixed_share=0.25,
        ),
        "wacc": WaccModel(
            e_pct=0.60,
            d_pct=0.40,
            rf=0.045,
            mrp=0.055,
            beta=1.10,
            spread=0.03,
            tax_rate=0.30,
        ),
        "capex": [
            CapexRow(0, "Inversión inicial", 730000.0),
        ],
        "fin": FinancingModel(
            enabled=False,
            debt_amount_0=0.0,
            interest_rate_annual=0.18,
            term_months=60,
            grace_months=0,
            amortization_type="french",
            tax_shield_enabled=False,
        ),
    }

def serialize_state(S: Dict) -> Dict:
    return {
        "project": asdict(S["project"]),
        "rev": asdict(S["rev"]),
        "cost": asdict(S["cost"]),
        "wc": asdict(S["wc"]),
        "wacc": asdict(S["wacc"]),
        "capex": [asdict(r) for r in S["capex"]],
        "fin": asdict(S["fin"]),
        "meta": {"exported_at": datetime.now().isoformat()},
    }

def load_state_from_json(payload: Dict) -> Dict:
    S = default_state()
    try:
        if "project" in payload:
            p = payload["project"]
            S["project"] = ProjectModel(
                p.get("name", S["project"].name),
                p.get("start_yyyymm", S["project"].start_yyyymm),
                int(p.get("horizon_months", S["project"].horizon_months)),
                safe_float(p.get("tax_rate", S["project"].tax_rate)),
            )
        if "rev" in payload:
            r = payload["rev"]
            S["rev"] = RevenueModel(
                safe_float(r.get("volume_0", S["rev"].volume_0)),
                safe_float(r.get("volume_growth_m", S["rev"].volume_growth_m)),
                safe_float(r.get("capacity_max", S["rev"].capacity_max)),
                safe_float(r.get("collection_factor", S["rev"].collection_factor)),
                safe_float(r.get("price_0", S["rev"].price_0)),
                safe_float(r.get("price_growth_m", S["rev"].price_growth_m)),
            )
        if "cost" in payload:
            c = payload["cost"]
            S["cost"] = CostModel(
                safe_float(c.get("fixed_0", S["cost"].fixed_0)),
                safe_float(c.get("fixed_growth_m", S["cost"].fixed_growth_m)),
                safe_float(c.get("var_unit_0", S["cost"].var_unit_0)),
                safe_float(c.get("var_unit_growth_m", S["cost"].var_unit_growth_m)),
                safe_float(c.get("maintenance_0", S["cost"].maintenance_0)),
                safe_float(c.get("maintenance_growth_m", S["cost"].maintenance_growth_m)),
            )
        if "wc" in payload:
            w = payload["wc"]
            S["wc"] = WorkingCapitalModel(
                bool(w.get("enabled", S["wc"].enabled)),
                int(w.get("dso", S["wc"].dso)),
                int(w.get("dpo", S["wc"].dpo)),
                int(w.get("dio", S["wc"].dio)),
                safe_float(w.get("ap_fixed_share", S["wc"].ap_fixed_share)),
            )
        if "wacc" in payload:
            w = payload["wacc"]
            S["wacc"] = WaccModel(
                safe_float(w.get("e_pct", S["wacc"].e_pct)),
                safe_float(w.get("d_pct", S["wacc"].d_pct)),
                safe_float(w.get("rf", S["wacc"].rf)),
                safe_float(w.get("mrp", S["wacc"].mrp)),
                safe_float(w.get("beta", S["wacc"].beta)),
                safe_float(w.get("spread", S["wacc"].spread)),
                safe_float(w.get("tax_rate", S["wacc"].tax_rate)),
            )
        if "capex" in payload:
            cap_list = []
            for row in payload["capex"]:
                cap_list.append(
                    CapexRow(
                        int(row.get("month_index", 0)),
                        str(row.get("item", "CapEx")),
                        safe_float(row.get("amount", 0.0)),
                    )
                )
            if cap_list:
                S["capex"] = cap_list
        if "fin" in payload:
            f = payload["fin"]
            S["fin"] = FinancingModel(
                bool(f.get("enabled", S["fin"].enabled)),
                safe_float(f.get("debt_amount_0", S["fin"].debt_amount_0)),
                safe_float(f.get("interest_rate_annual", S["fin"].interest_rate_annual)),
                int(f.get("term_months", S["fin"].term_months)),
                int(f.get("grace_months", S["fin"].grace_months)),
                str(f.get("amortization_type", S["fin"].amortization_type)),
                bool(f.get("tax_shield_enabled", S["fin"].tax_shield_enabled)),
            )
    except Exception:
        # si falla, vuelve a defaults
        return default_state()
    return S


# =========================
# WACC
# =========================
def compute_wacc(w: WaccModel) -> Tuple[float, float, float]:
    # Ke = Rf + beta*MRP
    ke = w.rf + w.beta * w.mrp
    # Kd = Rf + spread (simplificado)
    kd = w.rf + w.spread
    # WACC = E%*Ke + D%*Kd*(1-T)
    wacc_a = w.e_pct * ke + w.d_pct * kd * (1 - w.tax_rate)
    wacc_m = annual_to_monthly(wacc_a)
    return ke, wacc_a, wacc_m


# =========================
# Debt schedule (French/German + grace)
# =========================
def build_debt_schedule(
    D0: float,
    i_a: float,
    term_months: int,
    grace_months: int,
    amortization_type: str,
    horizon_months: int
) -> Dict[str, np.ndarray]:
    """
    Arrays de largo horizon_months para meses 1..horizon:
    balance_start, interest, principal, debt_service, balance_end
    """
    bal_start = np.zeros(horizon_months)
    interest = np.zeros(horizon_months)
    principal = np.zeros(horizon_months)
    service = np.zeros(horizon_months)
    bal_end = np.zeros(horizon_months)

    if D0 <= 0 or term_months <= 0:
        return {
            "balance_start": bal_start,
            "interest": interest,
            "principal": principal,
            "debt_service": service,
            "balance_end": bal_end,
        }

    n = min(term_months, horizon_months)
    g = min(max(grace_months, 0), n)
    n_eff = n - g

    i_m = annual_to_monthly(i_a)
    bal = D0

    # Cuota (francesa) o amortización fija (alemana)
    pmt = 0.0
    prin_fixed = 0.0

    if n_eff > 0:
        if amortization_type == "french":
            if abs(i_m) < 1e-12:
                pmt = D0 / n_eff
            else:
                pmt = D0 * (i_m * (1 + i_m) ** n_eff) / ((1 + i_m) ** n_eff - 1)
        elif amortization_type == "german":
            prin_fixed = D0 / n_eff
        else:
            raise ValueError("amortization_type debe ser 'french' o 'german'")

    for t in range(horizon_months):
        if t >= n:
            # fuera de plazo dentro del horizonte: 0
            continue

        bal_start[t] = bal
        interest[t] = bal * i_m

        if t < g or n_eff <= 0:
            # gracia (solo interés) o no hay meses amortizables
            principal[t] = 0.0
            service[t] = interest[t]
            bal_end[t] = bal
        else:
            if amortization_type == "french":
                principal[t] = max(0.0, pmt - interest[t])
                service[t] = principal[t] + interest[t]
            else:  # german
                principal[t] = prin_fixed
                service[t] = principal[t] + interest[t]

            bal = bal - principal[t]
            if bal < 0 and bal > -1e-6:
                bal = 0.0
            bal_end[t] = max(bal, 0.0)

    return {
        "balance_start": bal_start,
        "interest": interest,
        "principal": principal,
        "debt_service": service,
        "balance_end": bal_end,
    }


# =========================
# Validation
# =========================
def validate_inputs(project: ProjectModel, rev: RevenueModel, cost: CostModel, wc: WorkingCapitalModel,
                    wacc: WaccModel, capex: list[CapexRow], fin: FinancingModel) -> Tuple[list[str], list[str]]:
    errors = []
    warns = []

    if project.horizon_months < 12:
        warns.append("Horizonte < 12 meses: resultados pueden ser poco representativos.")
    if not (0 <= project.tax_rate <= 0.6):
        errors.append("Impuesto (tasa) fuera de rango razonable (0..0.6).")

    if rev.capacity_max <= 0:
        errors.append("Capacidad máxima debe ser > 0.")
    if not (0 <= rev.collection_factor <= 1):
        errors.append("Factor de cobranza debe estar entre 0 y 1.")

    if wc.enabled:
        if wc.dso < 0 or wc.dpo < 0 or wc.dio < 0:
            errors.append("DSO/DPO/DIO no pueden ser negativos.")
        if not (0 <= wc.ap_fixed_share <= 1):
            errors.append("% fijos elegibles en AP debe estar entre 0 y 1.")

    # WACC inputs sanity
    if abs((wacc.e_pct + wacc.d_pct) - 1.0) > 1e-6:
        warns.append("E% + D% no suma 100% (se usa tal cual).")
    if wacc.beta < 0:
        warns.append("Beta negativa: revisar.")
    if wacc.tax_rate < 0 or wacc.tax_rate > 0.6:
        warns.append("Tasa de impuesto en WACC fuera de rango típico (0..0.6).")

    # Capex
    for r in capex:
        if r.month_index < 0:
            errors.append("CapEx: month_index no puede ser negativo.")
        if r.amount < 0:
            warns.append("CapEx negativo: se interpreta como ingreso (reintegro/venta).")

    # Financing
    if fin.enabled:
        if fin.debt_amount_0 < 0:
            errors.append("Deuda inicial no puede ser negativa.")
        if fin.interest_rate_annual < 0:
            errors.append("Tasa anual de deuda no puede ser negativa.")
        if fin.term_months < 1:
            errors.append("Plazo de deuda debe ser >= 1.")
        if fin.grace_months < 0 or fin.grace_months > fin.term_months:
            errors.append("Gracia debe estar entre 0 y el plazo de la deuda.")
        if fin.amortization_type not in ("french", "german"):
            errors.append("Sistema de amortización inválido (french/german).")

    return errors, warns


# =========================
# Core calculation
# =========================
def build_cashflow_table(project: ProjectModel, rev: RevenueModel, cost: CostModel, wc: WorkingCapitalModel,
                         wacc: WaccModel, capex: list[CapexRow], fin: FinancingModel) -> Dict:
    n = int(project.horizon_months)
    months = np.arange(1, n + 1)

    # Revenue drivers
    vol = np.zeros(n)
    price = np.zeros(n)
    vol[0] = rev.volume_0
    price[0] = rev.price_0

    for t in range(1, n):
        vol[t] = min(rev.capacity_max, vol[t - 1] * (1 + rev.volume_growth_m))
        price[t] = price[t - 1] * (1 + rev.price_growth_m)

    revenue_gross = vol * price
    revenue = revenue_gross * rev.collection_factor

    # Costs
    fixed = np.zeros(n)
    var_unit = np.zeros(n)
    maint = np.zeros(n)
    fixed[0] = cost.fixed_0
    var_unit[0] = cost.var_unit_0
    maint[0] = cost.maintenance_0

    for t in range(1, n):
        fixed[t] = fixed[t - 1] * (1 + cost.fixed_growth_m)
        var_unit[t] = var_unit[t - 1] * (1 + cost.var_unit_growth_m)
        maint[t] = maint[t - 1] * (1 + cost.maintenance_growth_m)

    var_cost = vol * var_unit
    opex = fixed + var_cost + maint

    ebitda = revenue - opex

    # Simple depreciation ignored (kept minimal). Tax on EBITDA positive.
    tax = np.where(ebitda > 0, ebitda * project.tax_rate, 0.0)

    # Working capital delta (very simplified, but consistent month to month)
    d_wc = np.zeros(n)
    if wc.enabled:
        # AR approx = revenue * DSO/30
        # AP approx = (var_cost + fixed*share) * DPO/30
        ar = revenue * (wc.dso / 30.0)
        ap = (var_cost + fixed * wc.ap_fixed_share) * (wc.dpo / 30.0)
        inv = var_cost * (wc.dio / 30.0)
        wc_level = ar + inv - ap
        d_wc[0] = wc_level[0]
        for t in range(1, n):
            d_wc[t] = wc_level[t] - wc_level[t - 1]

    # CapEx by month
    capex_by_month = np.zeros(n)
    for r in capex:
        if 0 <= r.month_index < n:
            capex_by_month[r.month_index] += r.amount

    # FCFF array includes t=0
    fcff = np.zeros(n + 1)
    # t=0: -CapEx0 - ΔWC0
    fcff[0] = -capex_by_month[0] - d_wc[0]
    # t>=1
    for t in range(1, n + 1):
        idx = t - 1
        fcff[t] = (ebitda[idx] - tax[idx]) - d_wc[idx] - capex_by_month[idx]

    # WACC
    ke, wacc_a, wacc_m = compute_wacc(wacc)
    van = npv(wacc_m, fcff)
    tir_m = irr_monthly(fcff)
    tir_a = (1 + tir_m) ** 12 - 1 if tir_m is not None else None
    pb = payback_month(fcff)
    dpb = discounted_payback_month(fcff, wacc_m)

    # =======================
    # CFO layer: Debt/FCFE/DSCR/Buffer
    # =======================
    debt = build_debt_schedule(
        D0=fin.debt_amount_0 if fin.enabled else 0.0,
        i_a=fin.interest_rate_annual if fin.enabled else 0.0,
        term_months=fin.term_months if fin.enabled else 0,
        grace_months=fin.grace_months if fin.enabled else 0,
        amortization_type=fin.amortization_type if fin.enabled else "french",
        horizon_months=n
    )

    interest = debt["interest"]
    principal = debt["principal"]
    service = debt["debt_service"]

    # Flujo Operativo Disponible (antes de capex y antes de deuda)
    fod = ebitda - tax - d_wc

    # DSCR mensual
    dscr = np.full(n, np.nan)
    for i in range(n):
        if service[i] > 1e-12:
            dscr[i] = fod[i] / service[i]
    dscr_min = float(np.nanmin(dscr)) if np.any(np.isfinite(dscr)) else None

    # FCFE (permitimos D0 mayor que CapEx0+ΔWC0)
    fcfe = np.zeros(n + 1)
    capex0 = capex_by_month[0]
    dwc0 = d_wc[0]
    D0 = fin.debt_amount_0 if fin.enabled else 0.0

    # t=0: ingreso de deuda - inversión inicial (capex0 + Δwc0)
    fcfe[0] = D0 - (capex0 + dwc0)

    for t in range(1, n + 1):
        idx = t - 1
        tax_shield = (interest[idx] * project.tax_rate) if (fin.enabled and fin.tax_shield_enabled) else 0.0
        fcfe[t] = fcff[t] - interest[idx] - principal[idx] + tax_shield

    equity_cum = np.cumsum(fcfe)
    buffer_required = float(abs(np.min(equity_cum)))

    irr_e_m = irr_monthly(fcfe)
    irr_e_a = (1 + irr_e_m) ** 12 - 1 if irr_e_m is not None else None
    pb_e = payback_month(fcfe)
    dpb_e = discounted_payback_month(fcfe, wacc_m)  # proxy (si querés usar otra tasa, se puede)

    # DataFrame months 1..n
    df = pd.DataFrame({
        "Mes": months,
        "Volumen": vol,
        "Precio": price,
        "Ingresos": revenue,
        "Costos_fijos": fixed,
        "Costos_variables": var_cost,
        "Mantenimiento": maint,
        "Opex_total": opex,
        "EBITDA": ebitda,
        "Impuestos": tax,
        "ΔWC": d_wc,
        "CapEx": capex_by_month,
        "FCFF_mes": fcff[1:],  # t=1..n
        "FOD": fod,
        "Intereses": interest,
        "Amortización": principal,
        "Servicio_deuda": service,
        "DSCR": dscr,
        "FCFE_mes": fcfe[1:],
    })

    return {
        "df": df,
        "fcff": fcff,
        "fcfe": fcfe,
        "wacc_m": wacc_m,
        "ke": ke,
        "wacc_a": wacc_a,
        "van": van,
        "tir_m": tir_m,
        "tir_a": tir_a,
        "payback": pb,
        "discounted_payback": dpb,
        "dscr_min": dscr_min,
        "buffer_required": buffer_required,
        "irr_e_m": irr_e_m,
        "irr_e_a": irr_e_a,
        "payback_equity": pb_e,
        "discounted_payback_equity": dpb_e,
    }


# =========================
# Export: Excel / PDF
# =========================
def export_excel(df: pd.DataFrame, summary: Dict) -> bytes:
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Flujo_mensual", index=False)

        s = pd.DataFrame([
            ["VAN (USD)", summary["van"]],
            ["TIR mensual (económica)", summary["tir_m"] if summary["tir_m"] is not None else np.nan],
            ["TIR anual eq. (económica)", summary["tir_a"] if summary["tir_a"] is not None else np.nan],
            ["WACC anual", summary["wacc_a"]],
            ["WACC mensual", summary["wacc_m"]],
            ["Payback (mes)", summary["payback"] if summary["payback"] is not None else np.nan],
            ["Payback desc. (mes)", summary["discounted_payback"] if summary["discounted_payback"] is not None else np.nan],
            ["TIR Equity mensual", summary["irr_e_m"] if summary["irr_e_m"] is not None else np.nan],
            ["TIR Equity anual eq.", summary["irr_e_a"] if summary["irr_e_a"] is not None else np.nan],
            ["DSCR mínimo", summary["dscr_min"] if summary["dscr_min"] is not None else np.nan],
            ["Buffer requerido (USD)", summary["buffer_required"]],
        ], columns=["Métrica", "Valor"])
        s.to_excel(writer, sheet_name="Resumen", index=False)

    return output.getvalue()

def export_pdf_onepage(project: ProjectModel, summary: Dict, assumptions: Dict) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    width, height = letter

    y = height - 50
    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, y, f"Resumen Ejecutivo - {project.name}")
    y -= 22

    c.setFont("Helvetica", 10)
    c.drawString(40, y, f"Inicio: {project.start_yyyymm} | Horizonte: {project.horizon_months} meses | Moneda: USD nominal")
    y -= 14
    c.drawString(40, y, f"Fecha: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    y -= 18

    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, "KPIs")
    y -= 14

    c.setFont("Helvetica", 10)
    lines = [
        f"VAN (USD): {fmt_money(summary['van'])}",
        f"TIR mensual (económica): {fmt_pct(summary['tir_m'])}",
        f"TIR anual eq. (económica): {fmt_pct(summary['tir_a'])}",
        f"WACC anual: {fmt_pct(summary['wacc_a'])}",
        f"WACC mensual: {fmt_pct(summary['wacc_m'])}",
        f"Payback simple (mes): {summary['payback'] if summary['payback'] is not None else 'N/D'}",
        f"Payback descontado (mes): {summary['discounted_payback'] if summary['discounted_payback'] is not None else 'N/D'}",
        f"TIR Equity anual eq.: {fmt_pct(summary['irr_e_a'])}",
        f"DSCR mínimo: {('N/D' if summary['dscr_min'] is None else f'{summary['dscr_min']:.2f}')}",
        f"Buffer requerido (USD): {fmt_money(summary['buffer_required'])}",
    ]
    for line in lines:
        c.drawString(50, y, line)
        y -= 13

    y -= 8
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, "Supuestos clave")
    y -= 14
    c.setFont("Helvetica", 9)

    # Imprimir pocas líneas (1 hoja)
    for k, v in assumptions.items():
        c.drawString(50, y, f"{k}: {v}")
        y -= 11
        if y < 70:
            break

    y = 55
    c.setFont("Helvetica-Oblique", 8)
    c.drawString(40, y, "Convención: FCFF₀ = –CapEx₀ – ΔWC₀ | FCFE₀ = D0 – (CapEx₀ + ΔWC₀) | Descuento con WACC mensual.")
    c.showPage()
    c.save()
    return buf.getvalue()


# =========================
# Streamlit UI
# =========================
st.set_page_config(page_title="Modelo de inversión (FCFF + WACC)", layout="wide")

if "S" not in st.session_state:
    st.session_state["S"] = default_state()

S = st.session_state["S"]

# Sidebar JSON import/export
st.sidebar.header("Importar / Exportar JSON")
up = st.sidebar.file_uploader("Cargar JSON de proyecto", type=["json"])
if up is not None:
    try:
        payload = json.loads(up.read().decode("utf-8"))
        st.session_state["S"] = load_state_from_json(payload)
        S = st.session_state["S"]
        st.sidebar.success("JSON cargado.")
    except Exception:
        st.sidebar.error("No pude leer ese JSON.")

st.title("Modelo de inversión: Flujo mensual nominal (USD) + WACC por proyecto")

tab1, tab2, tab3, tab4 = st.tabs(["Inputs", "Resultados", "Exportar", "JSON"])

project: ProjectModel = S["project"]
rev: RevenueModel = S["rev"]
cost: CostModel = S["cost"]
wc: WorkingCapitalModel = S["wc"]
wacc: WaccModel = S["wacc"]
capex: list[CapexRow] = S["capex"]
fin: FinancingModel = S["fin"]

with tab1:
    st.subheader("1) Proyecto")
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        project.name = st.text_input("Nombre", value=project.name)
    with c2:
        project.start_yyyymm = st.text_input("Inicio (YYYY-MM)", value=project.start_yyyymm)
    with c3:
        project.horizon_months = st.number_input("Horizonte (meses)", min_value=12, max_value=240, value=int(project.horizon_months), step=12)
    with c4:
        project.tax_rate = st.number_input("Impuesto (tasa)", min_value=0.0, max_value=0.6, value=float(project.tax_rate), step=0.01, format="%.2f")

    st.divider()
    st.subheader("2) Ingresos")
    c1, c2, c3 = st.columns(3)
    with c1:
        rev.volume_0 = st.number_input("Volumen inicial (mes)", min_value=0.0, value=float(rev.volume_0), step=10.0)
        rev.volume_growth_m = st.number_input("Crec. volumen mensual", value=float(rev.volume_growth_m), step=0.001, format="%.4f")
    with c2:
        rev.capacity_max = st.number_input("Capacidad máxima (mes)", min_value=0.0, value=float(rev.capacity_max), step=10.0)
        rev.collection_factor = st.number_input("Factor cobranza (0..1)", min_value=0.0, max_value=1.0, value=float(rev.collection_factor), step=0.01, format="%.2f")
    with c3:
        rev.price_0 = st.number_input("Precio inicial (USD)", min_value=0.0, value=float(rev.price_0), step=5.0)
        rev.price_growth_m = st.number_input("Ajuste precio mensual", value=float(rev.price_growth_m), step=0.001, format="%.4f")

    st.divider()
    st.subheader("3) Costos")
    c1, c2, c3 = st.columns(3)
    with c1:
        cost.fixed_0 = st.number_input("Fijos iniciales (USD/mes)", min_value=0.0, value=float(cost.fixed_0), step=500.0)
        cost.fixed_growth_m = st.number_input("Ajuste fijos mensual", value=float(cost.fixed_growth_m), step=0.001, format="%.4f")
    with c2:
        cost.var_unit_0 = st.number_input("Variable unitario (USD/u)", min_value=0.0, value=float(cost.var_unit_0), step=1.0)
        cost.var_unit_growth_m = st.number_input("Ajuste variable mensual", value=float(cost.var_unit_growth_m), step=0.001, format="%.4f")
    with c3:
        cost.maintenance_0 = st.number_input("Mantenimiento (USD/mes)", min_value=0.0, value=float(cost.maintenance_0), step=50.0)
        cost.maintenance_growth_m = st.number_input("Ajuste mantenimiento mensual", value=float(cost.maintenance_growth_m), step=0.001, format="%.4f")

    st.divider()
    st.subheader("4) Capital de trabajo (DSO/DPO/DIO)")
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        wc.enabled = st.toggle("Habilitar WC", value=bool(wc.enabled))
    with c2:
        wc.dso = st.number_input("DSO", min_value=0, value=int(wc.dso), step=5)
    with c3:
        wc.dpo = st.number_input("DPO", min_value=0, value=int(wc.dpo), step=5)
    with c4:
        wc.dio = st.number_input("DIO", min_value=0, value=int(wc.dio), step=5)

    wc.ap_fixed_share = st.slider("% fijos elegibles en AP", min_value=0.0, max_value=1.0, value=float(wc.ap_fixed_share), step=0.05)

    st.divider()
    st.subheader("5) WACC (manual)")
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        wacc.e_pct = st.number_input("E% (0..1)", min_value=0.0, max_value=1.0, value=float(wacc.e_pct), step=0.05)
        wacc.d_pct = st.number_input("D% (0..1)", min_value=0.0, max_value=1.0, value=float(wacc.d_pct), step=0.05)
    with c2:
        wacc.rf = st.number_input("Rf anual", min_value=0.0, value=float(wacc.rf), step=0.005, format="%.4f")
        wacc.mrp = st.number_input("MRP anual", min_value=0.0, value=float(wacc.mrp), step=0.005, format="%.4f")
    with c3:
        wacc.beta = st.number_input("Beta", min_value=0.0, value=float(wacc.beta), step=0.05, format="%.2f")
        wacc.spread = st.number_input("Spread deuda", min_value=0.0, value=float(wacc.spread), step=0.005, format="%.4f")
    with c4:
        wacc.tax_rate = st.number_input("Tasa impuesto (para WACC)", min_value=0.0, max_value=0.6, value=float(wacc.tax_rate), step=0.01, format="%.2f")

    ke, wacc_a, wacc_m = compute_wacc(wacc)
    st.caption(f"Ke anual: {fmt_pct(ke)} | WACC anual: {fmt_pct(wacc_a)} | WACC mensual: {fmt_pct(wacc_m)}")

    st.divider()
    st.subheader("6) CapEx (tabla)")
    capex_df = pd.DataFrame([asdict(r) for r in capex])
    capex_df = st.data_editor(
        capex_df,
        num_rows="dynamic",
        use_container_width=True,
        column_config={
            "month_index": st.column_config.NumberColumn("month_index (0=mes inicial)", min_value=0, step=1),
            "item": st.column_config.TextColumn("item"),
            "amount": st.column_config.NumberColumn("amount (USD)", step=1000),
        },
    )
    # sync back
    new_capex = []
    for _, row in capex_df.iterrows():
        new_capex.append(CapexRow(int(row["month_index"]), str(row["item"]), safe_float(row["amount"])))
    S["capex"] = new_capex

    st.divider()
    st.subheader("7) Financiamiento (opcional)")
    c1, c2, c3, c4 = st.columns(4)
    with c1:
        fin.enabled = st.toggle("Usar deuda", value=bool(fin.enabled))
    with c2:
        fin.debt_amount_0 = st.number_input("Deuda inicial D0 (USD)", min_value=0.0, value=float(fin.debt_amount_0), step=5000.0)
    with c3:
        fin.interest_rate_annual = st.number_input("Tasa anual deuda", min_value=0.0, value=float(fin.interest_rate_annual), step=0.005, format="%.4f")
    with c4:
        fin.term_months = st.number_input("Plazo deuda (meses)", min_value=1, value=int(fin.term_months), step=12)

    c1, c2, c3 = st.columns(3)
    with c1:
        fin.grace_months = st.number_input("Gracia (meses, solo interés)", min_value=0, value=int(fin.grace_months), step=1)
    with c2:
        fin.amortization_type = st.selectbox("Sistema", ["french", "german"], index=0 if fin.amortization_type == "french" else 1)
    with c3:
        fin.tax_shield_enabled = st.toggle("Escudo fiscal (interés)", value=bool(fin.tax_shield_enabled))

# Always sync dataclasses back
S["project"] = project
S["rev"] = rev
S["cost"] = cost
S["wc"] = wc
S["wacc"] = wacc
S["fin"] = fin

with tab2:
    errors, warns = validate_inputs(project, rev, cost, wc, wacc, S["capex"], fin)
    if errors:
        st.error("Errores (bloqueantes):\n- " + "\n- ".join(errors))
        if warns:
            st.warning("Advertencias:\n- " + "\n- ".join(warns))
        st.stop()

    res = build_cashflow_table(project, rev, cost, wc, wacc, S["capex"], fin)
    df = res["df"]

    if warns:
        st.warning("Advertencias:\n- " + "\n- ".join(warns))

    # KPIs
    c1, c2, c3, c4, c5, c6 = st.columns(6)
    c1.metric("VAN (USD)", fmt_money(res["van"]))
    c2.metric("TIR mensual", fmt_pct(res["tir_m"]))
    c3.metric("TIR anual eq.", fmt_pct(res["tir_a"]))
    c4.metric("WACC anual", fmt_pct(res["wacc_a"]))
    c5.metric("Payback (mes)", str(res["payback"]) if res["payback"] is not None else "N/D")
    c6.metric("Payback desc. (mes)", str(res["discounted_payback"]) if res["discounted_payback"] is not None else "N/D")

    st.divider()
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("TIR Equity anual eq.", fmt_pct(res["irr_e_a"]))
    c2.metric("DSCR mínimo", "N/D" if res["dscr_min"] is None else f"{res['dscr_min']:.2f}")
    c3.metric("Buffer requerido (USD)", fmt_money(res["buffer_required"]))
    c4.metric("FCFE acumulado final", fmt_money(float(np.sum(res["fcfe"]))))

    # Alerts CFO
    alerts = []
    if fin.enabled and res["dscr_min"] is not None:
        if res["dscr_min"] < 1.0:
            alerts.append("🔴 DSCR < 1: no cubre servicio de deuda en al menos un mes.")
        elif res["dscr_min"] < 1.2:
            alerts.append("🟠 DSCR < 1.2: cobertura ajustada.")
    if res["buffer_required"] > 0:
        alerts.append(f"🔵 Buffer requerido (equity): {fmt_money(res['buffer_required'])} USD.")
    if alerts:
        st.warning("\n".join(alerts))

    st.divider()
    st.subheader("Curvas clave")
    # FCFF vs FCFE mensual
    chart_df = df[["Mes", "FCFF_mes", "FCFE_mes"]].set_index("Mes")
    st.line_chart(chart_df)

    # Caja acumulada equity
    eq_cum = np.cumsum(res["fcfe"])
    eq_cum_df = pd.DataFrame({"Mes": np.arange(0, len(eq_cum)), "Caja_equity_acum": eq_cum}).set_index("Mes")
    st.line_chart(eq_cum_df)

    st.divider()
    st.subheader("Tabla mensual (editable no; solo lectura)")
    st.dataframe(df, use_container_width=True, height=520)

with tab3:
    errors, _ = validate_inputs(project, rev, cost, wc, wacc, S["capex"], fin)
    if errors:
        st.error("Hay errores en Inputs. Corregí antes de exportar.")
        st.stop()

    res = build_cashflow_table(project, rev, cost, wc, wacc, S["capex"], fin)
    df = res["df"]

    st.subheader("Exportar")
    excel_bytes = export_excel(df, res)
    st.download_button(
        "Descargar Excel",
        data=excel_bytes,
        file_name=f"{project.name}_flujo.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )

    assumptions = {
        "Impuesto": project.tax_rate,
        "Volumen inicial": rev.volume_0,
        "Crec. vol mensual": rev.volume_growth_m,
        "Capacidad max": rev.capacity_max,
        "Precio inicial": rev.price_0,
        "Ajuste precio mensual": rev.price_growth_m,
        "Fijos iniciales": cost.fixed_0,
        "Var unit": cost.var_unit_0,
        "Mantenimiento": cost.maintenance_0,
        "WC habilitado": wc.enabled,
        "DSO": wc.dso,
        "DPO": wc.dpo,
        "DIO": wc.dio,
        "WACC anual": res["wacc_a"],
        "Deuda habilitada": fin.enabled,
        "D0": fin.debt_amount_0,
        "Tasa deuda anual": fin.interest_rate_annual,
        "Plazo deuda": fin.term_months,
        "Gracia": fin.grace_months,
        "Sistema": fin.amortization_type,
        "Escudo fiscal": fin.tax_shield_enabled,
    }
    pdf_bytes = export_pdf_onepage(project, res, assumptions)
    st.download_button(
        "Descargar PDF (1 hoja)",
        data=pdf_bytes,
        file_name=f"{project.name}_resumen.pdf",
        mime="application/pdf",
    )

with tab4:
    st.subheader("JSON del proyecto")
    payload = serialize_state(S)
    pretty = json.dumps(payload, indent=2, ensure_ascii=False)
    st.code(pretty, language="json")
    st.download_button(
        "Descargar JSON",
        data=pretty.encode("utf-8"),
        file_name=f"{project.name}.json",
        mime="application/json",
    )

