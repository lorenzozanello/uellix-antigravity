// Independent SROI control model for [QA-AUDIT-2026] Agua Segura y Bienestar Comunitario.
// Mirrors the documented SROI convention (year 1 undiscounted, dropoff^(yr-1), discount 1/(1+r)^(yr-1)).
// Written from the audit spec data ONLY. Computed in COP: the ratio is FX-invariant because
// numerator and denominator convert at the same rate.

const INVESTMENT_COP = 235_000_000;

// duration in years; pcts as whole numbers
function netPresentValue(quantity, proxyCop, { dw, attr, disp, dropoff, years }, r) {
  const base = quantity * proxyCop;
  const adj = (1 - dw / 100) * (1 - attr / 100) * (1 - disp / 100);
  let net = 0;
  for (let yr = 1; yr <= years; yr++) {
    net += base * adj * Math.pow(1 - dropoff / 100, yr - 1) * (1 / Math.pow(1 + r / 100, yr - 1));
  }
  return { gross: base * years, net };
}

const fmt = (n) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });

function run(r, proxyHourCop) {
  // Outcome 1 — hours saved. 120 households x 3.3 h/week x 52 weeks.
  const o1qty = 120 * 3.3 * 52;
  const o1 = netPresentValue(o1qty, proxyHourCop, { dw: 10, attr: 10, disp: 0, dropoff: 20, years: 3 }, r);

  // Outcome 2 — household water spend avoided. COP 53,000/month -> 636,000/household/year.
  const o2 = netPresentValue(120, 53_000 * 12, { dw: 15, attr: 10, disp: 0, dropoff: 15, years: 3 }, r);

  // Outcome 3 — wellbeing. 480 people x (78% - 32%) = 220.8 people changed.
  const o3 = netPresentValue(480 * 0.46, 300_000, { dw: 20, attr: 20, disp: 5, dropoff: 25, years: 2 }, r);

  // Outcome 4 — community management capacity. 22 of 25 complete.
  const o4 = netPresentValue(22, 800_000, { dw: 10, attr: 15, disp: 0, dropoff: 20, years: 3 }, r);

  const net = o1.net + o2.net + o3.net + o4.net;
  return { o1, o2, o3, o4, net, ratio: net / INVESTMENT_COP, o1qty };
}

console.log('=== Independent SROI control model (COP) ===');
console.log('Investment:', fmt(INVESTMENT_COP), 'COP\n');

for (const r of [0, 3.5]) {
  const noO1 = run(r, 0);
  console.log(`--- discount r = ${r}% ---`);
  console.log('  Outcome 2 net :', fmt(noO1.o2.net));
  console.log('  Outcome 3 net :', fmt(noO1.o3.net));
  console.log('  Outcome 4 net :', fmt(noO1.o4.net));
  console.log('  Subtotal (O2+O3+O4, Outcome 1 EXCLUDED — no proxy in spec):', fmt(noO1.net));
  console.log('  => SROI WITHOUT Outcome 1:', noO1.ratio.toFixed(3) + ':1');

  // What proxy/hour would Outcome 1 need for the spec's expected 2.7-3.2 band?
  const o1PerUnit = run(r, 1).o1.net; // net contributed per 1 COP/hour of proxy
  for (const target of [2.7, 3.2]) {
    const needed = (target * INVESTMENT_COP - noO1.net) / o1PerUnit;
    console.log(`  Proxy COP/hour needed to reach ${target}:1 =`, fmt(needed));
  }
  console.log('');
}
console.log('Outcome 1 quantity (hours/year) =', run(0, 1).o1qty.toLocaleString('es-CO'));
